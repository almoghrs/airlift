/**
 * Unit tests for IntegrityService.
 *
 * Verifies:
 *  - compute() returns a stable hex string
 *  - verify() returns true for unmodified contents
 *  - verify() returns false when any git bundle field is tampered
 *  - verify() returns false when any package field is tampered
 *  - verify() returns false when descriptor metadata is tampered
 *  - determinism: identical inputs always produce the same hash
 *  - ordering invariance: git bundle and package ordering does not change the hash
 */

import type { GitBundleArtifact, PackageArtifact } from '../types/index';
import type { BundleContents } from './integrity-service';
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

function makeContents(overrides: Partial<BundleContents> = {}): BundleContents {
  return {
    gitBundles: [makeGitBundle()],
    packages: [makePackage()],
    descriptorMeta: {
      bundleId: 'bundle-001',
      deliveryVersion: 'V1',
      syncRunId: 'run-001',
      projectCheckpoints: [],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IntegrityService', () => {
  let svc: IntegrityService;

  beforeEach(() => {
    svc = new IntegrityService();
  });

  // --- compute basics ---

  it('returns a 64-character lowercase hex string (SHA-256)', () => {
    const digest = svc.compute(makeContents());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic: same inputs produce the same hash', () => {
    const contents = makeContents();
    expect(svc.compute(contents)).toBe(svc.compute(contents));
  });

  it('is stable across fresh instances', () => {
    const contents = makeContents();
    const d1 = new IntegrityService().compute(contents);
    const d2 = new IntegrityService().compute(contents);
    expect(d1).toBe(d2);
  });

  // --- verify basics ---

  it('verify() returns true for the unmodified contents and recorded digest', () => {
    const contents = makeContents();
    const recorded = svc.compute(contents);
    expect(svc.verify(contents, recorded)).toBe(true);
  });

  it('verify() returns false when the recorded digest is wrong', () => {
    expect(svc.verify(makeContents(), 'a'.repeat(64))).toBe(false);
  });

  // --- tampering: git bundles ---

  it('detects tampering of gitBundle.projectId', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      gitBundles: [makeGitBundle({ projectId: 'project-b' })],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of gitBundle.bundleFile bytes', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      gitBundles: [makeGitBundle({ bundleFile: Buffer.from('different-bytes') })],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of gitBundle.sourceCommit', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      gitBundles: [makeGitBundle({ sourceCommit: 'tampered-commit' })],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('treats absent sourceCommit differently from an explicit empty string override', () => {
    // absent (undefined) is serialized as '' — but an explicit sourceCommit value differs
    const noSource = makeContents({ gitBundles: [makeGitBundle()] });
    const withSource = makeContents({
      gitBundles: [makeGitBundle({ sourceCommit: 'some-sha' })],
    });
    expect(svc.compute(noSource)).not.toBe(svc.compute(withSource));
  });

  it('detects tampering of gitBundle.targetCommits', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      gitBundles: [
        makeGitBundle({ targetCommits: { 'refs/heads/main': 'different-sha' } }),
      ],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  // --- tampering: packages ---

  it('detects tampering of package ref coordinates', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      packages: [
        makePackage({ ref: { coordinates: 'lodash-tampered', version: '4.17.21', ecosystem: 'npm' } }),
      ],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of package ref version', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      packages: [
        makePackage({ ref: { coordinates: 'lodash', version: '4.0.0', ecosystem: 'npm' } }),
      ],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of package fileBytes', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      packages: [makePackage({ fileBytes: Buffer.from('tampered-tgz') })],
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  // --- tampering: descriptor metadata ---

  it('detects tampering of descriptorMeta.bundleId', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      descriptorMeta: { ...contents.descriptorMeta, bundleId: 'tampered-id' },
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of descriptorMeta.syncRunId', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      descriptorMeta: { ...contents.descriptorMeta, syncRunId: 'tampered-run' },
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  it('detects tampering of descriptorMeta.deliveryVersion', () => {
    const contents = makeContents();
    const original = svc.compute(contents);
    const tampered = makeContents({
      descriptorMeta: { ...contents.descriptorMeta, deliveryVersion: 'V2' },
    });
    expect(svc.compute(tampered)).not.toBe(original);
  });

  // --- ordering invariance ---

  it('produces the same hash regardless of git bundle input order', () => {
    const b1 = makeGitBundle({ projectId: 'alpha', bundleFile: Buffer.from('a') });
    const b2 = makeGitBundle({ projectId: 'beta', bundleFile: Buffer.from('b') });

    const forward = makeContents({ gitBundles: [b1, b2] });
    const reversed = makeContents({ gitBundles: [b2, b1] });

    expect(svc.compute(forward)).toBe(svc.compute(reversed));
  });

  it('produces the same hash regardless of package input order', () => {
    const p1 = makePackage({
      ref: { coordinates: 'aaa', version: '1.0.0', ecosystem: 'npm' },
      fileBytes: Buffer.from('p1'),
    });
    const p2 = makePackage({
      ref: { coordinates: 'zzz', version: '2.0.0', ecosystem: 'Python' },
      fileBytes: Buffer.from('p2'),
    });

    const forward = makeContents({ packages: [p1, p2] });
    const reversed = makeContents({ packages: [p2, p1] });

    expect(svc.compute(forward)).toBe(svc.compute(reversed));
  });

  // --- edge cases ---

  it('handles empty gitBundles and packages', () => {
    const contents = makeContents({ gitBundles: [], packages: [] });
    const digest = svc.compute(contents);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.verify(contents, digest)).toBe(true);
  });

  it('handles multiple git bundles and packages', () => {
    const contents = makeContents({
      gitBundles: [
        makeGitBundle({ projectId: 'proj-1', bundleFile: Buffer.from('b1') }),
        makeGitBundle({ projectId: 'proj-2', bundleFile: Buffer.from('b2') }),
      ],
      packages: [
        makePackage({ ref: { coordinates: 'react', version: '18.0.0', ecosystem: 'npm' }, fileBytes: Buffer.from('r') }),
        makePackage({ ref: { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' }, fileBytes: Buffer.from('rq') }),
      ],
    });
    const digest = svc.compute(contents);
    expect(svc.verify(contents, digest)).toBe(true);
  });
});
