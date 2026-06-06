/**
 * Unit tests for PackingStrategy interface and FullSnapshotStrategy.
 * Requirements: 7.1, 7.2, 8.1, 8.2
 */
import type { PackageRef, SyncState, TrackedProject } from '../types/index';
import { FullSnapshotStrategy } from './packing-strategy';
import type { PackingStrategy } from './packing-strategy';

function makeProject(id = 'proj-1'): TrackedProject {
  return { id, gitLocation: 'https://github.com/example/repo.git', packages: [] };
}

function makeSyncState(): SyncState {
  return {
    projects: {
      'proj-1': { lastPackedCommit: 'abc123', packedVersions: new Set<PackageRef>() },
    },
  };
}

function makePackageRef(coordinates = 'lodash', version = '4.17.21'): PackageRef {
  return { coordinates, version, ecosystem: 'npm' };
}

describe('FullSnapshotStrategy', () => {
  it('satisfies the PackingStrategy interface', () => {
    const strategy: PackingStrategy = new FullSnapshotStrategy();
    expect(strategy).toBeDefined();
  });

  it('name equals "V1"', () => {
    expect(new FullSnapshotStrategy().name).toBe('V1');
  });

  describe('gitBaseline', () => {
    it('returns { kind: "FULL" } for a normal project', () => {
      expect(new FullSnapshotStrategy().gitBaseline(makeProject())).toEqual({ kind: 'FULL' });
    });

    it('returns { kind: "FULL" } when syncState is provided', () => {
      expect(new FullSnapshotStrategy().gitBaseline(makeProject(), makeSyncState())).toEqual({ kind: 'FULL' });
    });

    it('returns { kind: "FULL" } when syncState is undefined', () => {
      expect(new FullSnapshotStrategy().gitBaseline(makeProject(), undefined)).toEqual({ kind: 'FULL' });
    });

    it('does not vary by project identity', () => {
      const s = new FullSnapshotStrategy();
      expect(s.gitBaseline(makeProject('alpha'))).toEqual({ kind: 'FULL' });
      expect(s.gitBaseline(makeProject('beta'))).toEqual({ kind: 'FULL' });
    });
  });

  describe('packageFilter', () => {
    it('returns a function', () => {
      const filter = new FullSnapshotStrategy().packageFilter(makeProject());
      expect(typeof filter).toBe('function');
    });

    it('filter returns true for npm packages', () => {
      const filter = new FullSnapshotStrategy().packageFilter(makeProject());
      expect(filter(makePackageRef('lodash', '4.17.21'))).toBe(true);
      expect(filter(makePackageRef('react', '18.0.0'))).toBe(true);
    });

    it('filter returns true for Python packages', () => {
      const filter = new FullSnapshotStrategy().packageFilter(makeProject());
      const pyRef: PackageRef = { coordinates: 'requests', version: '2.31.0', ecosystem: 'Python' };
      expect(filter(pyRef)).toBe(true);
    });

    it('filter returns true regardless of syncState', () => {
      const s = new FullSnapshotStrategy();
      const ref = makePackageRef();
      expect(s.packageFilter(makeProject(), makeSyncState())(ref)).toBe(true);
      expect(s.packageFilter(makeProject(), undefined)(ref)).toBe(true);
    });
  });

  describe('SyncState independence', () => {
    it('gitBaseline result is identical with or without syncState', () => {
      const s = new FullSnapshotStrategy();
      const p = makeProject();
      expect(s.gitBaseline(p, makeSyncState())).toEqual(s.gitBaseline(p, undefined));
    });

    it('packageFilter is functionally identical with or without syncState', () => {
      const s = new FullSnapshotStrategy();
      const p = makeProject();
      const ref = makePackageRef();
      expect(s.packageFilter(p, makeSyncState())(ref)).toBe(s.packageFilter(p, undefined)(ref));
    });
  });
});
