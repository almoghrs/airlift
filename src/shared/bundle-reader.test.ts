/**
 * Unit tests for BundleReader.
 *
 * Verifies:
 *  - Successful load of a valid bundle written by BundleWriter
 *  - Rejection: file absent (descriptor_absent)
 *  - Rejection: file contains invalid JSON (descriptor_unparseable)
 *  - Rejection: JSON root is not an object (descriptor_unparseable)
 *  - Rejection: descriptor field missing from JSON (descriptor_absent)
 *  - Rejection: descriptor field is present but missing required properties (descriptor_unparseable)
 *  - Rejection: descriptor.integrityValue is absent (integrity_value_missing)
 *  - Rejection: descriptor.integrityValue is empty string (integrity_value_missing)
 *  - Rejection: integrity mismatch after byte-level tampering of a git bundle
 *  - Rejection: integrity mismatch after byte-level tampering of a package file
 *  - Rejection: integrity mismatch after tampering descriptor metadata
 *  - Rejection: gitBundles entry has invalid shape (descriptor_unparseable)
 *  - Rejection: packages entry has invalid shape (descriptor_unparseable)
 *  - No content is exposed on any rejection path
 *  - gitBundles / packages arrays absent in JSON treated as empty (still verifies)
 *
 * Requirements: 2.4, 2.5, 2.6
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BundleDescriptor, GitBundleArtifact, PackageArtifact } from '../types/index';
import { BundleReader, type BundleLoadResult } from './bundle-reader';
import { BundleWriter, _resetBundleCounter } from './bundle-writer';
import { IntegrityService } from './integrity-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitBundle(overrides: Partial<GitBundleArtifact> = {}): GitBundleArtifact {
  return {
    projectId: 'project-a',
    bundleFile: Buffer.from('git-bundle-bytes'),
    targetCommits: { 'refs/heads/main': 'deadbeef' },
    ...overrides,
  };
}

function makePackage(overrides: Partial<PackageArtifact> = {}): PackageArtifact {
  return {
    ref: { coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' },
    fileBytes: Buffer.from('package-tgz-bytes'),
    ...overrides,
  };
}

/** Returns true when result is a rejection. */
function isReject(result: BundleLoadResult): result is { reject: import('./bundle-reader').RejectReason } {
  return 'reject' in result;
}

/** Returns true when result is a loaded bundle. */
function isLoaded(result: BundleLoadResult): result is import('./bundle-reader').LoadedBundle {
  return 'bundle' in result;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('BundleReader', () => {
  let tmpDir: string;
  let integrityService: IntegrityService;
  let writer: BundleWriter;
  let reader: BundleReader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'bundle-reader-test-'));
    integrityService = new IntegrityService();
    _resetBundleCounter();
    writer = new BundleWriter(integrityService);
    reader = new BundleReader(integrityService);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('loads a valid bundle written by BundleWriter and returns the correct contents', async () => {
      const gitBundle = makeGitBundle();
      const pkg = makePackage();
      const bundle = writer.write({
        gitBundles: [gitBundle],
        packages: [pkg],
        projectCheckpoints: [],
        retrievalFailures: [],
        syncRunId: 'run-001',
        deliveryVersion: 'V1',
      });
      const outPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outPath);

      const result = await reader.read(outPath);

      expect(isLoaded(result)).toBe(true);
      if (!isLoaded(result)) return;

      // git bundles round-trip
      expect(result.bundle.gitBundles).toHaveLength(1);
      const loadedGitBundle = result.bundle.gitBundles[0]!;
      expect(loadedGitBundle.projectId).toBe('project-a');
      expect(loadedGitBundle.bundleFile).toEqual(gitBundle.bundleFile);
      expect(loadedGitBundle.targetCommits).toEqual(gitBundle.targetCommits);

      // packages round-trip
      expect(result.bundle.packages).toHaveLength(1);
      const loadedPkg = result.bundle.packages[0]!;
      expect(loadedPkg.ref).toEqual(pkg.ref);
      expect(loadedPkg.fileBytes).toEqual(pkg.fileBytes);

      // descriptor
      expect(result.bundle.descriptor.syncRunId).toBe('run-001');
      expect(result.bundle.descriptor.deliveryVersion).toBe('V1');
      expect(result.bundle.descriptor.integrityValue).toBeTruthy();
    });

    it('loads a bundle with multiple git bundles and packages', async () => {
      const bundle = writer.write({
        gitBundles: [
          makeGitBundle({ projectId: 'proj-1', bundleFile: Buffer.from('b1') }),
          makeGitBundle({ projectId: 'proj-2', bundleFile: Buffer.from('b2'), sourceCommit: 'abc123' }),
        ],
        packages: [
          makePackage({ ref: { coordinates: 'react', version: '18.0.0', ecosystem: 'npm' }, fileBytes: Buffer.from('r') }),
          makePackage({ ref: { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' }, fileBytes: Buffer.from('rq') }),
        ],
        projectCheckpoints: [],
        retrievalFailures: [],
        syncRunId: 'run-002',
        deliveryVersion: 'V2',
      });
      const outPath = join(tmpDir, 'multi.json');
      await writer.writeToDisk(bundle, outPath);

      const result = await reader.read(outPath);
      expect(isLoaded(result)).toBe(true);
      if (!isLoaded(result)) return;

      expect(result.bundle.gitBundles).toHaveLength(2);
      expect(result.bundle.packages).toHaveLength(2);

      // sourceCommit round-trip
      const proj2 = result.bundle.gitBundles.find((g) => g.projectId === 'proj-2');
      expect(proj2?.sourceCommit).toBe('abc123');
    });

    it('loads a bundle with empty gitBundles and packages arrays', async () => {
      const bundle = writer.write({
        gitBundles: [],
        packages: [],
        projectCheckpoints: [],
        retrievalFailures: [],
        syncRunId: 'run-003',
        deliveryVersion: 'V1',
      });
      const outPath = join(tmpDir, 'empty.json');
      await writer.writeToDisk(bundle, outPath);

      const result = await reader.read(outPath);
      expect(isLoaded(result)).toBe(true);
      if (!isLoaded(result)) return;
      expect(result.bundle.gitBundles).toHaveLength(0);
      expect(result.bundle.packages).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: file system
  // -------------------------------------------------------------------------

  describe('rejection — file absent', () => {
    it('returns descriptor_absent when the file does not exist', async () => {
      const result = await reader.read(join(tmpDir, 'nonexistent.json'));
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_absent');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: parse errors
  // -------------------------------------------------------------------------

  describe('rejection — parse errors', () => {
    it('returns descriptor_unparseable for invalid JSON', async () => {
      const p = join(tmpDir, 'bad.json');
      await writeFile(p, '{ not valid json', 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });

    it('returns descriptor_unparseable when JSON root is an array', async () => {
      const p = join(tmpDir, 'array.json');
      await writeFile(p, JSON.stringify([1, 2, 3]), 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });

    it('returns descriptor_unparseable when JSON root is a number', async () => {
      const p = join(tmpDir, 'number.json');
      await writeFile(p, '42', 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: descriptor absent / unparseable
  // -------------------------------------------------------------------------

  describe('rejection — descriptor absent or unparseable', () => {
    it('returns descriptor_absent when descriptor field is missing', async () => {
      const p = join(tmpDir, 'no-descriptor.json');
      await writeFile(p, JSON.stringify({ gitBundles: [], packages: [] }), 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_absent');
    });

    it('returns descriptor_absent when descriptor is null', async () => {
      const p = join(tmpDir, 'null-descriptor.json');
      await writeFile(p, JSON.stringify({ descriptor: null, gitBundles: [], packages: [] }), 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_absent');
    });

    it('returns descriptor_unparseable when descriptor is missing required fields', async () => {
      const p = join(tmpDir, 'bad-descriptor.json');
      // descriptor present but malformed — missing bundleId, deliveryVersion, etc.
      await writeFile(p, JSON.stringify({ descriptor: { foo: 'bar' }, gitBundles: [], packages: [] }), 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });

    it('returns descriptor_unparseable when descriptor is a string', async () => {
      const p = join(tmpDir, 'string-descriptor.json');
      await writeFile(p, JSON.stringify({ descriptor: 'not-an-object', gitBundles: [], packages: [] }), 'utf8');
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: integrity value missing
  // -------------------------------------------------------------------------

  describe('rejection — integrity_value_missing', () => {
    async function writeWithDescriptor(desc: Partial<BundleDescriptor>, path: string): Promise<void> {
      await writeFile(path, JSON.stringify({ descriptor: desc, gitBundles: [], packages: [] }), 'utf8');
    }

    const baseDesc = {
      bundleId: 'b-001',
      deliveryVersion: 'V1' as const,
      syncRunId: 'run-001',
      projectCheckpoints: [],
      integrityAlgorithm: 'SHA-256' as const,
    };

    it('returns integrity_value_missing when integrityValue field is absent', async () => {
      const p = join(tmpDir, 'no-iv.json');
      await writeWithDescriptor(baseDesc, p);
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_value_missing');
    });

    it('returns integrity_value_missing when integrityValue is empty string', async () => {
      const p = join(tmpDir, 'empty-iv.json');
      await writeWithDescriptor({ ...baseDesc, integrityValue: '' }, p);
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_value_missing');
    });

    it('returns integrity_value_missing when integrityValue is whitespace only', async () => {
      const p = join(tmpDir, 'ws-iv.json');
      await writeWithDescriptor({ ...baseDesc, integrityValue: '   ' }, p);
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_value_missing');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: integrity mismatch
  // -------------------------------------------------------------------------

  describe('rejection — integrity_mismatch', () => {
    /** Write a valid bundle to disk, return the path and the raw JSON. */
    async function writeValidBundle(): Promise<{ path: string; raw: Record<string, unknown> }> {
      const bundle = writer.write({
        gitBundles: [makeGitBundle()],
        packages: [makePackage()],
        projectCheckpoints: [],
        retrievalFailures: [],
        syncRunId: 'run-tamper',
        deliveryVersion: 'V1',
      });
      const outPath = join(tmpDir, `valid-${Date.now()}.json`);
      await writer.writeToDisk(bundle, outPath);
      const { readFile: rf } = await import('fs/promises');
      const raw = JSON.parse(await rf(outPath, 'utf8')) as Record<string, unknown>;
      return { path: outPath, raw };
    }

    it('returns integrity_mismatch with bundleId when git bundle bytes are tampered', async () => {
      const { path, raw } = await writeValidBundle();
      // Tamper the bundleFile bytes in the first git bundle
      const gitBundles = raw['gitBundles'] as Array<Record<string, unknown>>;
      const firstGitBundle = gitBundles[0]!;
      firstGitBundle['bundleFile'] = Buffer.from('tampered').toString('base64');
      await writeFile(path, JSON.stringify(raw), 'utf8');

      const result = await reader.read(path);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_mismatch');
      if (result.reject.kind !== 'integrity_mismatch') return;
      expect(typeof result.reject.bundleId).toBe('string');
      expect(result.reject.bundleId.length).toBeGreaterThan(0);
    });

    it('returns integrity_mismatch when package fileBytes are tampered', async () => {
      const { path, raw } = await writeValidBundle();
      const packages = raw['packages'] as Array<Record<string, unknown>>;
      const firstPkg = packages[0]!;
      firstPkg['fileBytes'] = Buffer.from('tampered-pkg').toString('base64');
      await writeFile(path, JSON.stringify(raw), 'utf8');

      const result = await reader.read(path);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_mismatch');
    });

    it('returns integrity_mismatch when descriptor syncRunId is tampered', async () => {
      const { path, raw } = await writeValidBundle();
      const desc = raw['descriptor'] as Record<string, unknown>;
      desc['syncRunId'] = 'tampered-run';
      await writeFile(path, JSON.stringify(raw), 'utf8');

      const result = await reader.read(path);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_mismatch');
    });

    it('returns integrity_mismatch when descriptor deliveryVersion is tampered', async () => {
      const { path, raw } = await writeValidBundle();
      const desc = raw['descriptor'] as Record<string, unknown>;
      desc['deliveryVersion'] = 'V2';
      await writeFile(path, JSON.stringify(raw), 'utf8');

      const result = await reader.read(path);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_mismatch');
    });

    it('returns integrity_mismatch when the integrity value itself is swapped for a different valid-looking hash', async () => {
      const { path, raw } = await writeValidBundle();
      const desc = raw['descriptor'] as Record<string, unknown>;
      // Replace with a plausible but wrong 64-char hex string
      desc['integrityValue'] = 'a'.repeat(64);
      await writeFile(path, JSON.stringify(raw), 'utf8');

      const result = await reader.read(path);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('integrity_mismatch');
    });
  });

  // -------------------------------------------------------------------------
  // Rejection: malformed arrays
  // -------------------------------------------------------------------------

  describe('rejection — malformed gitBundles / packages entries', () => {
    /** Build a valid descriptor with a precomputed integrityValue for empty contents. */
    function makeValidDescriptor(integrityValue: string): BundleDescriptor {
      return {
        bundleId: 'b-bad-arrays',
        deliveryVersion: 'V1',
        syncRunId: 'run-bad',
        projectCheckpoints: [],
        integrityValue,
        integrityAlgorithm: 'SHA-256',
      };
    }

    it('returns descriptor_unparseable for a non-object gitBundles entry', async () => {
      // Compute a real integrity value for empty git + empty packages
      const descriptorMeta = {
        bundleId: 'b-bad-arrays',
        deliveryVersion: 'V1' as const,
        syncRunId: 'run-bad',
        projectCheckpoints: [],
      };
      const iv = integrityService.compute({ gitBundles: [], packages: [], descriptorMeta });
      const p = join(tmpDir, 'bad-git-entry.json');
      await writeFile(
        p,
        JSON.stringify({
          descriptor: makeValidDescriptor(iv),
          gitBundles: ['not-an-object'],
          packages: [],
        }),
        'utf8',
      );
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });

    it('returns descriptor_unparseable for a gitBundles entry missing projectId', async () => {
      const descriptorMeta = {
        bundleId: 'b-bad-arrays',
        deliveryVersion: 'V1' as const,
        syncRunId: 'run-bad',
        projectCheckpoints: [],
      };
      const iv = integrityService.compute({ gitBundles: [], packages: [], descriptorMeta });
      const p = join(tmpDir, 'missing-pid.json');
      await writeFile(
        p,
        JSON.stringify({
          descriptor: makeValidDescriptor(iv),
          // missing projectId
          gitBundles: [{ bundleFile: 'abc', targetCommits: {} }],
          packages: [],
        }),
        'utf8',
      );
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });

    it('returns descriptor_unparseable for a packages entry missing fileBytes', async () => {
      const descriptorMeta = {
        bundleId: 'b-bad-arrays',
        deliveryVersion: 'V1' as const,
        syncRunId: 'run-bad',
        projectCheckpoints: [],
      };
      const iv = integrityService.compute({ gitBundles: [], packages: [], descriptorMeta });
      const p = join(tmpDir, 'missing-filebytes.json');
      await writeFile(
        p,
        JSON.stringify({
          descriptor: makeValidDescriptor(iv),
          gitBundles: [],
          // missing fileBytes
          packages: [{ ref: { coordinates: 'x', version: '1.0.0', ecosystem: 'npm' } }],
        }),
        'utf8',
      );
      const result = await reader.read(p);
      expect(isReject(result)).toBe(true);
      if (!isReject(result)) return;
      expect(result.reject.kind).toBe('descriptor_unparseable');
    });
  });

  // -------------------------------------------------------------------------
  // No content exposed on rejection
  // -------------------------------------------------------------------------

  describe('no content exposed on rejection', () => {
    it('does not expose bundle property on descriptor_absent', async () => {
      const result = await reader.read(join(tmpDir, 'ghost.json'));
      expect(result).not.toHaveProperty('bundle');
    });

    it('does not expose bundle property on integrity_mismatch', async () => {
      const bundle = writer.write({
        gitBundles: [makeGitBundle()],
        packages: [],
        projectCheckpoints: [],
        retrievalFailures: [],
        syncRunId: 'run-x',
        deliveryVersion: 'V1',
      });
      const p = join(tmpDir, 'tamper-no-expose.json');
      await writer.writeToDisk(bundle, p);

      const { readFile: rf } = await import('fs/promises');
      const raw = JSON.parse(await rf(p, 'utf8')) as Record<string, unknown>;
      const desc = raw['descriptor'] as Record<string, unknown>;
      desc['integrityValue'] = 'b'.repeat(64);
      await writeFile(p, JSON.stringify(raw), 'utf8');

      const result = await reader.read(p);
      expect(result).not.toHaveProperty('bundle');
      expect(result).toHaveProperty('reject');
    });
  });

  // -------------------------------------------------------------------------
  // Edge: missing arrays treated as empty
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('treats absent gitBundles and packages as empty arrays (verifies against empty-content hash)', async () => {
      // Build the correct integrity value for empty content with this descriptor meta
      const descriptorMeta = {
        bundleId: 'b-no-arrays',
        deliveryVersion: 'V1' as const,
        syncRunId: 'run-no-arrays',
        projectCheckpoints: [],
      };
      const iv = integrityService.compute({ gitBundles: [], packages: [], descriptorMeta });
      const desc: BundleDescriptor = {
        ...descriptorMeta,
        integrityValue: iv,
        integrityAlgorithm: 'SHA-256',
      };
      const p = join(tmpDir, 'no-arrays.json');
      // Omit gitBundles and packages fields entirely
      await writeFile(p, JSON.stringify({ descriptor: desc }), 'utf8');

      const result = await reader.read(p);
      expect(isLoaded(result)).toBe(true);
      if (!isLoaded(result)) return;
      expect(result.bundle.gitBundles).toHaveLength(0);
      expect(result.bundle.packages).toHaveLength(0);
    });
  });
});
