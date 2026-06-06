/**
 * Unit tests for BundleWriter.
 *
 * Verifies:
 *  - write() returns a TransferBundle with the original gitBundles and packages
 *  - write() embeds a valid BundleDescriptor with correct metadata fields
 *  - write() computes and embeds a verifiable integrity value (SHA-256)
 *  - write() assigns a unique bundleId on every call (Requirement 2.2)
 *  - write() records projectCheckpoints in the descriptor (Requirements 7.4, 8.4)
 *  - write() records retrievalFailures in the projectCheckpoints
 *  - writeToDisk() serializes the bundle as valid JSON with base64 binary fields
 *  - writeToDisk() round-trips: deserialising the JSON restores the original bytes
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type {
    GitBundleArtifact,
    PackageArtifact,
    ProjectCheckpoint,
    RetrievalFailure,
} from '../types/index';
import type { BundleFileFormat, WriteInput } from './bundle-writer';
import { BundleWriter, _resetBundleCounter } from './bundle-writer';
import { IntegrityService } from './integrity-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGitBundle(overrides: Partial<GitBundleArtifact> = {}): GitBundleArtifact {
  return {
    projectId: 'project-a',
    bundleFile: Buffer.from('git-bundle-bytes'),
    targetCommits: { 'refs/heads/main': 'abc123' },
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

function makeCheckpoint(overrides: Partial<ProjectCheckpoint> = {}): ProjectCheckpoint {
  return {
    projectId: 'project-a',
    gitTargetCommits: { 'refs/heads/main': 'abc123' },
    packedVersions: [{ coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' }],
    retrievalFailures: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<WriteInput> = {}): WriteInput {
  return {
    gitBundles: [makeGitBundle()],
    packages: [makePackage()],
    projectCheckpoints: [makeCheckpoint()],
    retrievalFailures: [],
    syncRunId: 'run-001',
    deliveryVersion: 'V1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BundleWriter', () => {
  let writer: BundleWriter;
  let integrityService: IntegrityService;

  beforeEach(() => {
    integrityService = new IntegrityService();
    writer = new BundleWriter(integrityService);
    // Reset the per-Packer counter so bundle-id assertions are deterministic.
    _resetBundleCounter();
  });

  // -------------------------------------------------------------------------
  // Structure of the returned TransferBundle
  // -------------------------------------------------------------------------

  describe('write() — TransferBundle structure', () => {
    it('returns gitBundles identical to the input', () => {
      const input = makeInput();
      const bundle = writer.write(input);
      expect(bundle.gitBundles).toBe(input.gitBundles);
    });

    it('returns packages identical to the input', () => {
      const input = makeInput();
      const bundle = writer.write(input);
      expect(bundle.packages).toBe(input.packages);
    });

    it('embeds the correct syncRunId in the descriptor', () => {
      const bundle = writer.write(makeInput({ syncRunId: 'run-xyz' }));
      expect(bundle.descriptor.syncRunId).toBe('run-xyz');
    });

    it('embeds the correct deliveryVersion in the descriptor', () => {
      const v1 = writer.write(makeInput({ deliveryVersion: 'V1' }));
      expect(v1.descriptor.deliveryVersion).toBe('V1');

      const v2 = writer.write(makeInput({ deliveryVersion: 'V2' }));
      expect(v2.descriptor.deliveryVersion).toBe('V2');
    });

    it('sets integrityAlgorithm to "SHA-256"', () => {
      const bundle = writer.write(makeInput());
      expect(bundle.descriptor.integrityAlgorithm).toBe('SHA-256');
    });

    it('embeds a 64-character hex integrityValue', () => {
      const bundle = writer.write(makeInput());
      expect(bundle.descriptor.integrityValue).toMatch(/^[0-9a-f]{64}$/);
    });

    it('copies projectCheckpoints into the descriptor', () => {
      const checkpoints = [makeCheckpoint(), makeCheckpoint({ projectId: 'project-b' })];
      const bundle = writer.write(makeInput({ projectCheckpoints: checkpoints }));
      expect(bundle.descriptor.projectCheckpoints).toEqual(checkpoints);
    });
  });

  // -------------------------------------------------------------------------
  // Bundle ID uniqueness (Requirement 2.2)
  // -------------------------------------------------------------------------

  describe('write() — bundle id uniqueness', () => {
    it('assigns a non-empty bundleId', () => {
      const bundle = writer.write(makeInput());
      expect(bundle.descriptor.bundleId).toBeTruthy();
    });

    it('assigns a different bundleId on each call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        ids.add(writer.write(makeInput()).descriptor.bundleId);
      }
      expect(ids.size).toBe(20);
    });

    it('bundleId contains a UUID segment', () => {
      const bundle = writer.write(makeInput());
      // UUID pattern embedded in the id
      expect(bundle.descriptor.bundleId).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    });

    it('bundleId includes a monotonic counter suffix', () => {
      // After resetting the counter the first id should end with "-1"
      const bundle = writer.write(makeInput());
      expect(bundle.descriptor.bundleId).toMatch(/-1$/);
    });

    it('bundleIds from two separate BundleWriter instances are distinct', () => {
      const writer2 = new BundleWriter(new IntegrityService());
      const id1 = writer.write(makeInput()).descriptor.bundleId;
      const id2 = writer2.write(makeInput()).descriptor.bundleId;
      expect(id1).not.toBe(id2);
    });
  });

  // -------------------------------------------------------------------------
  // Integrity value (Requirements 2.3)
  // -------------------------------------------------------------------------

  describe('write() — integrity', () => {
    it('embeds an integrity value that IntegrityService.verify() accepts', () => {
      const input = makeInput();
      const bundle = writer.write(input);

      const contents = {
        gitBundles: bundle.gitBundles,
        packages: bundle.packages,
        descriptorMeta: {
          bundleId: bundle.descriptor.bundleId,
          deliveryVersion: bundle.descriptor.deliveryVersion,
          syncRunId: bundle.descriptor.syncRunId,
          projectCheckpoints: bundle.descriptor.projectCheckpoints,
        },
      };

      expect(integrityService.verify(contents, bundle.descriptor.integrityValue)).toBe(true);
    });

    it('produces different integrity values when git bundle bytes change', () => {
      const bundle1 = writer.write(makeInput());
      const bundle2 = writer.write(
        makeInput({
          gitBundles: [makeGitBundle({ bundleFile: Buffer.from('different-bytes') })],
        }),
      );
      expect(bundle1.descriptor.integrityValue).not.toBe(bundle2.descriptor.integrityValue);
    });

    it('produces different integrity values when package bytes change', () => {
      const bundle1 = writer.write(makeInput());
      const bundle2 = writer.write(
        makeInput({
          packages: [makePackage({ fileBytes: Buffer.from('different-tgz') })],
        }),
      );
      expect(bundle1.descriptor.integrityValue).not.toBe(bundle2.descriptor.integrityValue);
    });

    it('produces different integrity values when syncRunId changes', () => {
      const bundle1 = writer.write(makeInput({ syncRunId: 'run-001' }));
      const bundle2 = writer.write(makeInput({ syncRunId: 'run-002' }));
      expect(bundle1.descriptor.integrityValue).not.toBe(bundle2.descriptor.integrityValue);
    });
  });

  // -------------------------------------------------------------------------
  // Checkpoint and failure recording (Requirements 7.4, 8.4)
  // -------------------------------------------------------------------------

  describe('write() — checkpoints and retrieval failures', () => {
    it('records per-project target commit references in projectCheckpoints', () => {
      const checkpoint = makeCheckpoint({
        projectId: 'my-project',
        gitTargetCommits: { 'refs/heads/main': 'deadbeef', 'refs/tags/v1.0': 'cafebabe' },
      });
      const bundle = writer.write(makeInput({ projectCheckpoints: [checkpoint] }));

      const stored = bundle.descriptor.projectCheckpoints[0]!;
      expect(stored.projectId).toBe('my-project');
      expect(stored.gitTargetCommits).toEqual({
        'refs/heads/main': 'deadbeef',
        'refs/tags/v1.0': 'cafebabe',
      });
    });

    it('records packed package versions (coordinates, version, ecosystem) in checkpoints', () => {
      const checkpoint = makeCheckpoint({
        packedVersions: [
          { coordinates: 'react', version: '18.0.0', ecosystem: 'npm' },
          { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' },
        ],
      });
      const bundle = writer.write(makeInput({ projectCheckpoints: [checkpoint] }));

      const versions = bundle.descriptor.projectCheckpoints[0]!.packedVersions;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toEqual({ coordinates: 'react', version: '18.0.0', ecosystem: 'npm' });
      expect(versions[1]).toEqual({ coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' });
    });

    it('records retrieval failures in the projectCheckpoints', () => {
      const failure: RetrievalFailure = {
        ref: { coordinates: 'missing-pkg', version: '1.0.0', ecosystem: 'npm' },
        reason: 'Not found on Source_Artifactory',
      };
      const checkpoint = makeCheckpoint({ retrievalFailures: [failure] });
      const bundle = writer.write(makeInput({ projectCheckpoints: [checkpoint] }));

      const storedFailures = bundle.descriptor.projectCheckpoints[0]!.retrievalFailures;
      expect(storedFailures).toHaveLength(1);
      expect(storedFailures[0]).toEqual(failure);
    });

    it('handles empty projectCheckpoints (no projects)', () => {
      const bundle = writer.write(makeInput({ projectCheckpoints: [] }));
      expect(bundle.descriptor.projectCheckpoints).toEqual([]);
    });

    it('handles multiple project checkpoints', () => {
      const checkpoints = [
        makeCheckpoint({ projectId: 'proj-a' }),
        makeCheckpoint({ projectId: 'proj-b' }),
        makeCheckpoint({ projectId: 'proj-c' }),
      ];
      const bundle = writer.write(makeInput({ projectCheckpoints: checkpoints }));
      expect(bundle.descriptor.projectCheckpoints).toHaveLength(3);
      expect(bundle.descriptor.projectCheckpoints.map((c) => c.projectId)).toEqual([
        'proj-a',
        'proj-b',
        'proj-c',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // writeToDisk — serialization format
  // -------------------------------------------------------------------------

  describe('writeToDisk()', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'bundle-writer-test-'));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('writes a valid JSON file to disk', async () => {
      const bundle = writer.write(makeInput());
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const raw = await readFile(outputPath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('JSON contains descriptor, gitBundles, and packages keys', async () => {
      const bundle = writer.write(makeInput());
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed).toHaveProperty('descriptor');
      expect(parsed).toHaveProperty('gitBundles');
      expect(parsed).toHaveProperty('packages');
    });

    it('descriptor in the JSON matches the bundle descriptor', async () => {
      const bundle = writer.write(makeInput());
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.descriptor).toEqual(bundle.descriptor);
    });

    it('git bundle bytes are base64-encoded in the JSON', async () => {
      const gitBytes = Buffer.from('hello git bundle');
      const bundle = writer.write(makeInput({ gitBundles: [makeGitBundle({ bundleFile: gitBytes })] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles[0]!.bundleFile).toBe(gitBytes.toString('base64'));
    });

    it('package bytes are base64-encoded in the JSON', async () => {
      const pkgBytes = Buffer.from('hello package tgz');
      const bundle = writer.write(makeInput({ packages: [makePackage({ fileBytes: pkgBytes })] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.packages[0]!.fileBytes).toBe(pkgBytes.toString('base64'));
    });

    it('base64 git bundle bytes round-trip back to original bytes', async () => {
      const gitBytes = Buffer.from('round-trip git bundle data');
      const bundle = writer.write(makeInput({ gitBundles: [makeGitBundle({ bundleFile: gitBytes })] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      const restored = Buffer.from(parsed.gitBundles[0]!.bundleFile, 'base64');
      expect(restored).toEqual(gitBytes);
    });

    it('base64 package bytes round-trip back to original bytes', async () => {
      const pkgBytes = Buffer.from('round-trip package data');
      const bundle = writer.write(makeInput({ packages: [makePackage({ fileBytes: pkgBytes })] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      const restored = Buffer.from(parsed.packages[0]!.fileBytes, 'base64');
      expect(restored).toEqual(pkgBytes);
    });

    it('preserves sourceCommit when present', async () => {
      const gb = makeGitBundle({ sourceCommit: 'source-sha-123' });
      const bundle = writer.write(makeInput({ gitBundles: [gb] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles[0]!.sourceCommit).toBe('source-sha-123');
    });

    it('omits sourceCommit when absent', async () => {
      const gb = makeGitBundle(); // no sourceCommit
      const bundle = writer.write(makeInput({ gitBundles: [gb] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles[0]!).not.toHaveProperty('sourceCommit');
    });

    it('preserves targetCommits map in the JSON', async () => {
      const targetCommits = { 'refs/heads/main': 'abc123', 'refs/tags/v1.0': 'def456' };
      const gb = makeGitBundle({ targetCommits });
      const bundle = writer.write(makeInput({ gitBundles: [gb] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles[0]!.targetCommits).toEqual(targetCommits);
    });

    it('preserves package ref fields (coordinates, version, ecosystem) in the JSON', async () => {
      const ref = { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' as const };
      const bundle = writer.write(makeInput({ packages: [makePackage({ ref })] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.packages[0]!.ref).toEqual(ref);
    });

    it('handles empty gitBundles and packages', async () => {
      const bundle = writer.write(makeInput({ gitBundles: [], packages: [] }));
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles).toEqual([]);
      expect(parsed.packages).toEqual([]);
    });

    it('writes multiple git bundles and packages correctly', async () => {
      const input = makeInput({
        gitBundles: [
          makeGitBundle({ projectId: 'proj-1', bundleFile: Buffer.from('b1') }),
          makeGitBundle({ projectId: 'proj-2', bundleFile: Buffer.from('b2') }),
        ],
        packages: [
          makePackage({ ref: { coordinates: 'react', version: '18.0.0', ecosystem: 'npm' }, fileBytes: Buffer.from('r') }),
          makePackage({ ref: { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' }, fileBytes: Buffer.from('rq') }),
        ],
      });
      const bundle = writer.write(input);
      const outputPath = join(tmpDir, 'bundle.json');
      await writer.writeToDisk(bundle, outputPath);

      const parsed: BundleFileFormat = JSON.parse(await readFile(outputPath, 'utf8'));
      expect(parsed.gitBundles).toHaveLength(2);
      expect(parsed.packages).toHaveLength(2);
      expect(parsed.gitBundles[0]!.projectId).toBe('proj-1');
      expect(parsed.gitBundles[1]!.projectId).toBe('proj-2');
    });
  });
});
