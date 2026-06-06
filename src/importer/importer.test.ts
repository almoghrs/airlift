/**
 * Unit tests for Importer orchestrator.
 *
 * All heavy I/O is mocked at the boundary (BundleReader, GitImporter,
 * PackageImporter) so these tests are fast and deterministic.
 *
 * Test scenarios:
 *   1. Successful import — valid bundle, all items succeed → 'succeeded fully'
 *   2. Integrity rejection — BundleReader rejects → 'failed', zero git/pkg ops
 *   3. Descriptor absent rejection → 'failed', zero git/pkg ops
 *   4. Git failures surfaced in the report
 *   5. Git skips force 'succeeded with skipped or failed items' (Requirement 3.7)
 *   6. Package failures surfaced in the report
 *
 * Requirements: 2.4, 2.5, 2.6, 3.7, 5.2, 6.1, 6.4
 */

import type { BundleLoadResult } from '../shared/bundle-reader';
import type { EcosystemAdapter } from '../shared/ecosystem-adapter';
import type {
    BundleDescriptor,
    DeliveryVersion,
    Ecosystem,
    PackageArtifact,
    TransferBundle,
} from '../types/index';
import type { GitImportResult } from './git-importer';
import type { PackageImportResult } from './package-importer';

// ---------------------------------------------------------------------------
// Helpers — defined before jest.mock factories so they can be reused
// ---------------------------------------------------------------------------

// Mutable objects that test cases can overwrite to control what each
// mocked dependency returns.  The jest.mock factories capture these by
// reference so any mutation before a call is visible inside the SUT.

let mockReadResult: BundleLoadResult | undefined = undefined;
let mockGitResult: GitImportResult = { imported: [], skipped: [], failed: [] };
let mockPkgResult: PackageImportResult = { uploaded: [], skipped: [], failures: [] };

const mockRead = jest.fn(async () => mockReadResult);
const mockImportBundles = jest.fn(async () => mockGitResult);
const mockImportPackages = jest.fn(async () => mockPkgResult);

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

jest.mock('../shared/bundle-reader', () => ({
  BundleReader: jest.fn().mockImplementation(() => ({ read: mockRead })),
}));

jest.mock('../shared/integrity-service', () => ({
  IntegrityService: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./git-importer', () => ({
  GitImporter: jest.fn().mockImplementation(() => ({ importBundles: mockImportBundles })),
}));

jest.mock('./package-importer', () => ({
  PackageImporter: jest.fn().mockImplementation(() => ({ importPackages: mockImportPackages })),
}));

// Import the SUT *after* the mocks are registered
import type { ImporterConfig } from './importer';
import { Importer } from './importer';

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<BundleDescriptor> = {}): BundleDescriptor {
  return {
    bundleId: 'bundle-test-001',
    deliveryVersion: 'V1',
    syncRunId: 'run-001',
    projectCheckpoints: [
      {
        projectId: 'proj-a',
        gitTargetCommits: { 'refs/heads/main': 'sha-abc' },
        packedVersions: [],
        retrievalFailures: [],
      },
    ],
    integrityValue: 'valid-hash',
    integrityAlgorithm: 'SHA-256',
    ...overrides,
  };
}

function makeBundle(overrides: Partial<TransferBundle> = {}): TransferBundle {
  return {
    gitBundles: [
      {
        projectId: 'proj-a',
        bundleFile: Buffer.from('fake-bundle'),
        targetCommits: { 'refs/heads/main': 'sha-abc' },
      },
    ],
    packages: [],
    descriptor: makeDescriptor(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ImporterConfig> = {}): ImporterConfig {
  return {
    bundlePath: '/tmp/fake.bundle',
    gitConfig: {
      baseUrl: 'https://gitlab.example.com',
      token: 'tok',
      namespace: 'org',
      localReposBase: '/tmp/repos',
    },
    adapters: new Map<Ecosystem, EcosystemAdapter>(),
    syncRunId: 'run-001',
    deliveryVersion: 'V1' as DeliveryVersion,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Importer orchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mutable state so each test starts clean
    mockReadResult = undefined;
    mockGitResult = { imported: [], skipped: [], failed: [] };
    mockPkgResult = { uploaded: [], skipped: [], failures: [] };
  });

  // -------------------------------------------------------------------------
  // 1. Successful import
  // -------------------------------------------------------------------------
  describe('successful import', () => {
    it('returns succeeded fully when all items import without issues', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };
      mockPkgResult = { uploaded: [], skipped: [], failures: [] };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('succeeded fully');
      expect(report.failures).toHaveLength(0);
      expect(report.createdRepositories).toEqual(['proj-a']);
      expect(report.syncRunId).toBe('run-001');
      expect(report.deliveryVersion).toBe('V1');
    });

    it('calls BundleReader.read with the configured bundlePath', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };

      await new Importer().run(makeConfig({ bundlePath: '/custom/path.bundle' }));

      expect(mockRead).toHaveBeenCalledWith('/custom/path.bundle');
    });

    it('calls GitImporter.importBundles with the correct bundles and descriptor', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };

      await new Importer().run(makeConfig());

      expect(mockImportBundles).toHaveBeenCalledWith(
        bundle.gitBundles,
        bundle.descriptor,
        expect.any(Object),
      );
    });

    it('calls PackageImporter.importPackages with the correct packages', async () => {
      const pkgArtifact: PackageArtifact = {
        ref: { coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' },
        fileBytes: Buffer.from('bytes'),
      };
      const bundle = makeBundle({ packages: [pkgArtifact] });
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };

      await new Importer().run(makeConfig());

      expect(mockImportPackages).toHaveBeenCalledWith(
        [pkgArtifact],
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Integrity rejection → failed report, zero writes
  // -------------------------------------------------------------------------
  describe('bundle rejection — zero writes', () => {
    it('returns overallStatus failed on integrity_mismatch and performs no git/pkg operations', async () => {
      mockReadResult = { reject: { kind: 'integrity_mismatch', bundleId: 'bundle-test-001' } };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('failed');
      expect(report.failures.length).toBeGreaterThan(0);
      expect(report.failures[0]?.reason).toMatch(/integrity mismatch/i);
      // Zero writes: neither git nor package importer should have been invoked
      expect(mockImportBundles).not.toHaveBeenCalled();
      expect(mockImportPackages).not.toHaveBeenCalled();
    });

    it('returns overallStatus failed on descriptor_absent', async () => {
      mockReadResult = { reject: { kind: 'descriptor_absent' } };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('failed');
      expect(report.failures[0]?.reason).toMatch(/descriptor.*absent/i);
      expect(mockImportBundles).not.toHaveBeenCalled();
      expect(mockImportPackages).not.toHaveBeenCalled();
    });

    it('returns overallStatus failed on descriptor_unparseable', async () => {
      mockReadResult = { reject: { kind: 'descriptor_unparseable', details: 'unexpected token' } };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('failed');
      expect(report.failures[0]?.reason).toMatch(/descriptor.*parse/i);
      expect(mockImportBundles).not.toHaveBeenCalled();
      expect(mockImportPackages).not.toHaveBeenCalled();
    });

    it('returns overallStatus failed on integrity_value_missing', async () => {
      mockReadResult = { reject: { kind: 'integrity_value_missing' } };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('failed');
      expect(report.failures[0]?.reason).toMatch(/integrity value.*missing/i);
      expect(mockImportBundles).not.toHaveBeenCalled();
      expect(mockImportPackages).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Git failures surfaced in the report
  // -------------------------------------------------------------------------
  describe('git failure surfacing', () => {
    it('includes git failures in the report failures list', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = {
        imported: [],
        skipped: [],
        failed: [{ itemId: 'proj-a', reason: 'git fetch failed: connection refused' }],
      };

      const report = await new Importer().run(makeConfig());

      expect(report.failures).toContainEqual(
        expect.objectContaining({ itemId: 'proj-a', reason: expect.stringContaining('git fetch failed') }),
      );
    });

    it('sets overallStatus to "succeeded with skipped or failed items" when a git bundle fails (Requirement 3.7)', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = {
        imported: [],
        skipped: [],
        failed: [{ itemId: 'proj-a', reason: 'push failed' }],
      };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('succeeded with skipped or failed items');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Git skips force 'succeeded with skipped or failed items' (Req 3.7)
  // -------------------------------------------------------------------------
  describe('git skips force non-full success status (Requirement 3.7)', () => {
    it('returns "succeeded with skipped or failed items" when git bundles were skipped', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: [], skipped: ['proj-a'], failed: [] };

      const report = await new Importer().run(makeConfig());

      expect(report.overallStatus).toBe('succeeded with skipped or failed items');
      expect(report.skippedRepositories).toContain('proj-a');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Package failures surfaced in the report
  // -------------------------------------------------------------------------
  describe('package failure surfacing', () => {
    it('includes package failures in the report failures list', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };
      mockPkgResult = {
        uploaded: [],
        skipped: [],
        failures: [{ itemId: 'npm:lodash@4.17.21', reason: 'upload timed out' }],
      };

      const report = await new Importer().run(makeConfig());

      expect(report.failures).toContainEqual(
        expect.objectContaining({ itemId: 'npm:lodash@4.17.21' }),
      );
      expect(report.overallStatus).toBe('succeeded with skipped or failed items');
    });

    it('surfaces ledger-halt failure in the report', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };
      mockPkgResult = {
        uploaded: [],
        skipped: [],
        failures: [],
        haltedByLedgerFailure: {
          ref: { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' },
          reason: 'ledger write failed: disk full',
        },
      };

      const report = await new Importer().run(makeConfig());

      expect(report.failures.some((f) => f.reason.includes('ledger write failed'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Report includes per-project data from the descriptor checkpoints
  // -------------------------------------------------------------------------
  describe('per-project report data', () => {
    it('populates perProject from the descriptor checkpoints', async () => {
      const bundle = makeBundle();
      mockReadResult = { bundle };
      mockGitResult = { imported: ['proj-a'], skipped: [], failed: [] };

      const report = await new Importer().run(makeConfig());

      expect(report.perProject).toHaveLength(1);
      expect(report.perProject[0]?.projectId).toBe('proj-a');
      expect(report.perProject[0]?.gitTargetCommits).toEqual({ 'refs/heads/main': 'sha-abc' });
    });
  });
});
