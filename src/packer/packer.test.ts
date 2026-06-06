/**
 * Unit tests for the Packer orchestrator (V1 wiring).
 *
 * All external I/O is mocked:
 *   - ManifestValidator.load  → returns a VALID or INVALID result
 *   - GitPacker.pack          → returns a successful artifact
 *   - EcosystemAdapter        → discoverVersions returns empty; parseDependencies/download unused
 *   - BundleWriter.writeToDisk → spy to assert it is called
 *
 * Requirements: 1.5, 2.1, 5.1, 7.2, 8.2
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EcosystemAdapter } from '../shared/ecosystem-adapter';
import type { Ecosystem, Manifest, PackageRef } from '../types/index';
import type { PackerConfig } from './packer';
import { Packer } from './packer';
import { FullSnapshotStrategy } from './packing-strategy';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock ManifestValidator so we can control what it returns
jest.mock('../shared/manifest-validator', () => {
  return {
    ManifestValidator: jest.fn().mockImplementation(() => ({
      load: jest.fn(),
    })),
  };
});

// Mock GitPacker so we don't shell out to git
jest.mock('./git-packer', () => {
  return {
    GitPacker: jest.fn().mockImplementation(() => ({
      pack: jest.fn(),
    })),
  };
});

// Mock BundleWriter.writeToDisk to avoid actual disk I/O in most tests
// (we spy on it rather than fully mock so write() still works)
import { BundleWriter } from '../shared/bundle-writer';
import { ManifestValidator } from '../shared/manifest-validator';
import { GitPacker } from './git-packer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidManifest(): Manifest {
  return {
    status: 'VALID',
    projects: [
      {
        id: 'project-1',
        gitLocation: 'https://github.com/example/repo.git',
        packages: [],
      },
    ],
  };
}

function makeGitArtifact() {
  return {
    ok: true as const,
    artifact: {
      projectId: 'project-1',
      bundleFile: Buffer.from('fake-git-bundle'),
      targetCommits: { 'refs/heads/main': 'abc123' },
    },
  };
}

/** Build a minimal EcosystemAdapter mock that returns no versions. */
function makeAdapterMock(ecosystem: Ecosystem): EcosystemAdapter {
  return {
    ecosystem,
    discoverVersions: jest.fn().mockResolvedValue([] as PackageRef[]),
    parseDependencies: jest.fn().mockResolvedValue([] as PackageRef[]),
    download: jest.fn().mockRejectedValue(new Error('not called')),
    upload: jest.fn().mockRejectedValue(new Error('not called')),
    targetRepositoryKind: ecosystem === 'npm' ? 'npm' : 'pypi',
  } as unknown as EcosystemAdapter;
}

function makeConfig(outputBundlePath: string): PackerConfig {
  const adapters = new Map<Ecosystem, EcosystemAdapter>([
    ['npm', makeAdapterMock('npm')],
    ['Python', makeAdapterMock('Python')],
  ]);
  return {
    manifestPath: '/fake/manifest.json',
    outputBundlePath,
    syncRunId: 'run-test-001',
    adapters,
    strategy: new FullSnapshotStrategy(),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Packer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'packer-test-'));
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path — VALID manifest, successful git pack, no packages
  // -------------------------------------------------------------------------

  describe('VALID manifest — successful run', () => {
    let writeToDiskSpy: jest.SpyInstance;

    beforeEach(() => {
      // ManifestValidator mock returns VALID
      (ManifestValidator as jest.MockedClass<typeof ManifestValidator>).mockImplementation(() => ({
        load: jest.fn().mockResolvedValue({
          status: 'VALID',
          manifest: makeValidManifest(),
          errors: [],
        }),
      }));

      // GitPacker mock returns a successful artifact
      (GitPacker as unknown as jest.MockedClass<{ new(): { pack: jest.Mock } }>).mockImplementation(() => ({
        pack: jest.fn().mockResolvedValue(makeGitArtifact()),
      }));

      // Spy on BundleWriter.writeToDisk (let write() run for real)
      writeToDiskSpy = jest
        .spyOn(BundleWriter.prototype, 'writeToDisk')
        .mockResolvedValue(undefined);
    });

    it('returns PackReport with overallStatus "succeeded fully"', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.overallStatus).toBe('succeeded fully');
    });

    it('report carries the syncRunId', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.syncRunId).toBe('run-test-001');
    });

    it('report carries the delivery version from the strategy', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.deliveryVersion).toBe('V1');
    });

    it('report contains one perProject entry for the single project', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.perProject).toHaveLength(1);
      expect(report.perProject[0]!.projectId).toBe('project-1');
    });

    it('report contains a non-empty bundleId', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.bundleId).toBeTruthy();
    });

    it('calls BundleWriter.writeToDisk with the configured output path', async () => {
      const packer = new Packer();
      const bundlePath = join(tmpDir, 'bundle.json');
      const config = makeConfig(bundlePath);
      await packer.run(config);

      expect(writeToDiskSpy).toHaveBeenCalledTimes(1);
      expect(writeToDiskSpy).toHaveBeenCalledWith(expect.anything(), bundlePath);
    });

    it('report has no failures when everything succeeds', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.failures).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // INVALID manifest — must abort with failure report
  // -------------------------------------------------------------------------

  describe('INVALID manifest', () => {
    beforeEach(() => {
      (ManifestValidator as jest.MockedClass<typeof ManifestValidator>).mockImplementation(() => ({
        load: jest.fn().mockResolvedValue({
          status: 'INVALID',
          errors: [
            {
              code: 'NO_TRACKED_PROJECTS',
              message: 'Manifest contains no Tracked_Projects',
            },
            {
              code: 'DUPLICATE_ID',
              message: 'Duplicate project id "proj-a"',
              projectId: 'proj-a',
              duplicatedId: 'proj-a',
            },
          ],
        }),
      }));
    });

    it('returns PackReport with overallStatus "failed"', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.overallStatus).toBe('failed');
    });

    it('report contains failures derived from validation errors', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.failures.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT call GitPacker.pack', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      await packer.run(config);

      // GitPacker is mocked; if it had been instantiated and pack() called,
      // the mock would register the call.
      const mockInstance = (GitPacker as jest.MockedClass<typeof GitPacker>).mock.instances[0];
      if (mockInstance) {
        expect(mockInstance.pack).not.toHaveBeenCalled();
      } else {
        // GitPacker was never even instantiated — also correct
        expect(true).toBe(true);
      }
    });

    it('does NOT write a bundle to disk', async () => {
      const writeToDiskSpy = jest
        .spyOn(BundleWriter.prototype, 'writeToDisk')
        .mockResolvedValue(undefined);

      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      await packer.run(config);

      expect(writeToDiskSpy).not.toHaveBeenCalled();
      writeToDiskSpy.mockRestore();
    });

    it('report perProject is empty', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.perProject).toHaveLength(0);
    });

    it('carries the syncRunId even on failure', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.syncRunId).toBe('run-test-001');
    });
  });

  // -------------------------------------------------------------------------
  // Git pack failure — project excluded, run continues
  // -------------------------------------------------------------------------

  describe('git pack failure for one project', () => {
    beforeEach(() => {
      (ManifestValidator as jest.MockedClass<typeof ManifestValidator>).mockImplementation(() => ({
        load: jest.fn().mockResolvedValue({
          status: 'VALID',
          manifest: makeValidManifest(),
          errors: [],
        }),
      }));

      (GitPacker as unknown as jest.MockedClass<{ new(): { pack: jest.Mock } }>).mockImplementation(() => ({
        pack: jest.fn().mockResolvedValue({
          ok: false,
          projectId: 'project-1',
          reason: 'git clone failed: repository not found',
        }),
      }));

      jest.spyOn(BundleWriter.prototype, 'writeToDisk').mockResolvedValue(undefined);
    });

    it('returns a report with "succeeded with skipped or failed items" when git fails', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.overallStatus).toBe('succeeded with skipped or failed items');
    });

    it('records the git failure in report.failures', async () => {
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      const report = await packer.run(config);

      expect(report.failures.some((f) => f.itemId === 'project-1')).toBe(true);
    });

    it('still writes the bundle to disk (even with no git bundles)', async () => {
      const writeToDiskSpy = jest.spyOn(BundleWriter.prototype, 'writeToDisk');
      const packer = new Packer();
      const config = makeConfig(join(tmpDir, 'bundle.json'));
      await packer.run(config);

      expect(writeToDiskSpy).toHaveBeenCalledTimes(1);
    });
  });
});
