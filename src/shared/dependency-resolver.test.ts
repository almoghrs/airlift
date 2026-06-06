/**
 * Unit tests for DependencyResolver.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.5, 8.6, 8.7
 *
 * Scenarios covered:
 *   1. Linear chain A → B → C — all retrieved successfully
 *   2. Cycle A → B → A — terminates without infinite loop
 *   3. Diamond A → B, A → C, B → D, C → D — D included exactly once
 *   4. Filter excludes already-visited root versions
 *   5. Retrieval failure: B fails, A and C still included
 *   6. No adapter registered — throws clearly
 *   7. Empty roots — returns empty included set
 */

import type { Ecosystem, PackageRef } from '../types/index';
import { DependencyResolver } from './dependency-resolver';
import type { EcosystemAdapter, PackageFilter } from './ecosystem-adapter';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal PackageRef. */
function ref(coordinates: string, version = '1.0.0', ecosystem: Ecosystem = 'npm'): PackageRef {
  return { coordinates, version, ecosystem };
}

/** Byte buffer stub — content doesn't matter for these unit tests. */
function fakeBytes(label: string): Buffer {
  return Buffer.from(`fake-package:${label}`);
}

/**
 * Builds a mock EcosystemAdapter.
 *
 * @param packages Map of "coordinates@version" → { deps, failDownload? }
 */
function makeAdapter(
  ecosystem: Ecosystem,
  packages: Map<
    string,
    { deps: PackageRef[]; failDownload?: boolean }
  >,
): EcosystemAdapter {
  return {
    ecosystem,
    targetRepositoryKind: ecosystem === 'npm' ? 'npm' : 'pypi',

    async discoverVersions(): Promise<PackageRef[]> {
      return [];
    },

    async download(r: PackageRef): Promise<Buffer> {
      const entry = packages.get(`${r.coordinates}@${r.version}`);
      if (!entry) {
        throw new Error(`Package not found: ${r.coordinates}@${r.version}`);
      }
      if (entry.failDownload) {
        throw new Error(`Download failed for ${r.coordinates}@${r.version}`);
      }
      return fakeBytes(`${r.coordinates}@${r.version}`);
    },

    async parseDependencies(fileBytes: Buffer): Promise<PackageRef[]> {
      // Decode the label we embedded in fakeBytes to look up deps.
      const label = fileBytes.toString().replace('fake-package:', '');
      const entry = packages.get(label);
      return entry?.deps ?? [];
    },

    async upload(): Promise<{ kind: 'uploaded' }> {
      return { kind: 'uploaded' };
    },
  };
}

/** Include-all filter (V1 semantics). */
const includeAll: PackageFilter = () => true;

// ---------------------------------------------------------------------------
// 1. Linear chain: A → B → C
// ---------------------------------------------------------------------------

describe('linear chain A → B → C', () => {
  it('includes all three packages exactly once', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');
    const pkgC = ref('C');

    const packages = new Map([
      ['A@1.0.0', { deps: [pkgB] }],
      ['B@1.0.0', { deps: [pkgC] }],
      ['C@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], includeAll);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(3);

    const coords = result.included.map(a => a.ref.coordinates).sort();
    expect(coords).toEqual(['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// 2. Cycle: A → B → A
// ---------------------------------------------------------------------------

describe('cycle A → B → A', () => {
  it('terminates without infinite loop and includes A and B exactly once', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');

    const packages = new Map([
      ['A@1.0.0', { deps: [pkgB] }],
      ['B@1.0.0', { deps: [pkgA] }], // back-edge to A
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], includeAll);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(2);

    const coords = result.included.map(a => a.ref.coordinates).sort();
    expect(coords).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// 3. Diamond: A → B, A → C, B → D, C → D
// ---------------------------------------------------------------------------

describe('diamond dependency graph', () => {
  it('includes D exactly once', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');
    const pkgC = ref('C');
    const pkgD = ref('D');

    const packages = new Map([
      ['A@1.0.0', { deps: [pkgB, pkgC] }],
      ['B@1.0.0', { deps: [pkgD] }],
      ['C@1.0.0', { deps: [pkgD] }], // second path to D
      ['D@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], includeAll);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(4);

    // D appears exactly once
    const dEntries = result.included.filter(a => a.ref.coordinates === 'D');
    expect(dEntries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Filter excludes already-visited root versions
// ---------------------------------------------------------------------------

describe('filter', () => {
  it('excludes roots that the filter rejects', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');

    const packages = new Map([
      ['A@1.0.0', { deps: [] }],
      ['B@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    // Filter that excludes B
    const excludeB: PackageFilter = (r) => r.coordinates !== 'B';

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA, pkgB], excludeB);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.ref.coordinates).toBe('A');
  });

  it('does not re-enqueue deps that the filter rejects', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');

    const packages = new Map([
      // A depends on B, but B is filtered out
      ['A@1.0.0', { deps: [pkgB] }],
      ['B@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const excludeB: PackageFilter = (r) => r.coordinates !== 'B';

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], excludeB);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.ref.coordinates).toBe('A');
  });
});

// ---------------------------------------------------------------------------
// 5. Retrieval failure: B fails, A and C still included
// ---------------------------------------------------------------------------

describe('retrieval failure handling', () => {
  it('records failure for B and still includes A and C', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');
    const pkgC = ref('C');

    const packages = new Map([
      ['A@1.0.0', { deps: [pkgB, pkgC] }],
      ['B@1.0.0', { deps: [], failDownload: true }], // B will fail
      ['C@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], includeAll);

    // A and C included; B excluded
    expect(result.included).toHaveLength(2);
    const coords = result.included.map(a => a.ref.coordinates).sort();
    expect(coords).toEqual(['A', 'C']);

    // B recorded as failure
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.ref.coordinates).toBe('B');
    expect(result.failures[0]!.reason).toBeTruthy();
  });

  it('continues processing when a root itself fails to download', async () => {
    const pkgA = ref('A');
    const pkgB = ref('B');

    const packages = new Map([
      ['A@1.0.0', { deps: [], failDownload: true }],
      ['B@1.0.0', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA, pkgB], includeAll);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.ref.coordinates).toBe('A');

    expect(result.included).toHaveLength(1);
    expect(result.included[0]!.ref.coordinates).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// 6. No adapter registered — throws clearly
// ---------------------------------------------------------------------------

describe('missing adapter', () => {
  it('throws a descriptive error when the ecosystem has no adapter', async () => {
    const pkgA: PackageRef = { coordinates: 'A', version: '1.0.0', ecosystem: 'Python' };

    // Only npm adapter registered
    const packages = new Map([['A@1.0.0', { deps: [] }]]);
    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    await expect(resolver.resolve([pkgA], includeAll)).rejects.toThrow(
      /no adapter registered for ecosystem "Python"/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Empty roots
// ---------------------------------------------------------------------------

describe('empty roots', () => {
  it('returns empty included and failures when roots is empty', async () => {
    const adapters = new Map<Ecosystem, EcosystemAdapter>();
    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([], includeAll);

    expect(result.included).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. parseDependencies returns version specifiers — resolver uses them as-is
// ---------------------------------------------------------------------------

describe('parseDependencies version passthrough', () => {
  it('uses the exact version from parseDependencies as the visited key', async () => {
    // A@1.0.0 declares B@2.3.4 as dependency — the resolver should enqueue
    // B@2.3.4 exactly (not try to discover latest or re-interpret the version).
    const pkgA = ref('A', '1.0.0');
    const pkgB = ref('B', '2.3.4');

    const packages = new Map([
      ['A@1.0.0', { deps: [pkgB] }],
      ['B@2.3.4', { deps: [] }],
    ]);

    const adapters = new Map<Ecosystem, EcosystemAdapter>([
      ['npm', makeAdapter('npm', packages)],
    ]);

    const resolver = new DependencyResolver(adapters);
    const result = await resolver.resolve([pkgA], includeAll);

    expect(result.failures).toHaveLength(0);
    expect(result.included).toHaveLength(2);

    const bEntry = result.included.find(a => a.ref.coordinates === 'B');
    expect(bEntry?.ref.version).toBe('2.3.4');
  });
});
