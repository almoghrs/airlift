/**
 * Unit tests for GitImporter.
 *
 * All tests use the real `git` CLI in actual temp directories, so they verify
 * the git operations produce the expected on-disk state without any mocking.
 *
 * Test scenarios:
 *  1. Basic import: bundle applied, target refs set correctly
 *  2. Re-import skip: ledger shows already imported → PRESENT, skipped
 *  3. Rollback: fetch failure restores pre-fetch refs
 *  4. Repo creation failure isolation: skip + continue with remaining bundles
 *  5. History retention: incremental bundle on existing repo retains prior history
 *  6. Multiple bundles: success of one is independent of others
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.2, 6.3, 6.5
 */

import { exec } from 'child_process';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { BundleDescriptor, GitBundleArtifact, ProjectCheckpoint } from '../types/index';
import type { GitLabConfig } from './git-importer';
import { GitImporter } from './git-importer';
import { ImportLedgerService } from './import-ledger';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Git test helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given directory; returns trimmed stdout.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${args.map((a) => `"${a}"`).join(' ')}`, { cwd });
  return stdout.trim();
}

/**
 * Create a new regular (non-bare) git repo at `dir` with one initial commit.
 * Returns the SHA of the initial commit.
 */
async function createSourceRepo(dir: string): Promise<string> {
  await execAsync('git init', { cwd: dir });
  await execAsync('git config user.email "test@example.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
  await writeFile(join(dir, 'file.txt'), 'hello');
  await execAsync('git add .', { cwd: dir });
  await execAsync('git commit -m "initial commit"', { cwd: dir });
  return git(['rev-parse', 'HEAD'], dir);
}

/**
 * Add a second commit to an existing repo; returns the new HEAD SHA.
 */
async function addCommit(dir: string, content: string = 'update'): Promise<string> {
  await writeFile(join(dir, 'file.txt'), content);
  await execAsync('git add .', { cwd: dir });
  await execAsync(`git commit -m "${content}"`, { cwd: dir });
  return git(['rev-parse', 'HEAD'], dir);
}

/**
 * Create a git bundle of the full history and return its raw bytes as a Buffer.
 */
async function createBundle(sourceDir: string, bundlePath: string): Promise<Buffer> {
  await execAsync(`git bundle create "${bundlePath}" --all`, { cwd: sourceDir });
  const { readFile } = await import('fs/promises');
  return readFile(bundlePath);
}

/**
 * Read the SHA a given ref points to in a bare repo.
 * Returns undefined when the ref does not exist.
 */
async function resolveRef(repoPath: string, ref: string): Promise<string | undefined> {
  try {
    return await git(['rev-parse', ref], repoPath);
  } catch {
    return undefined;
  }
}

/**
 * Get all refs in a bare repo as a Map<ref, sha>.
 */
async function getAllRefs(repoPath: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  try {
    const output = await git(['show-ref'], repoPath);
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      refs.set(trimmed.slice(spaceIdx + 1), trimmed.slice(0, spaceIdx));
    }
  } catch {
    // no refs
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Test factories
// ---------------------------------------------------------------------------

function makeDescriptor(
  checkpoints: ProjectCheckpoint[],
  overrides: Partial<BundleDescriptor> = {},
): BundleDescriptor {
  return {
    bundleId: 'bundle-001',
    deliveryVersion: 'V1',
    syncRunId: 'run-001',
    projectCheckpoints: checkpoints,
    integrityValue: 'abc123',
    integrityAlgorithm: 'SHA-256',
    ...overrides,
  };
}

function makeCheckpoint(
  projectId: string,
  gitTargetCommits: Record<string, string>,
): ProjectCheckpoint {
  return {
    projectId,
    gitTargetCommits,
    packedVersions: [],
    retrievalFailures: [],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GitImporter', () => {
  let workDir: string;         // temporary working area for all test artifacts
  let localReposBase: string;  // where destination bare repos land

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'git-importer-test-'));
    localReposBase = join(workDir, 'repos');
    // localReposBase will be created by the importer (or explicitly)
    await import('fs/promises').then(({ mkdir }) => mkdir(localReposBase, { recursive: true }));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<GitLabConfig> = {}): GitLabConfig {
    return {
      baseUrl: 'https://gitlab.example.com',
      token: 'test-token',
      namespace: 'test-org',
      localReposBase,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // 1. Basic import: creates target repo and sets refs correctly
  // -------------------------------------------------------------------------
  describe('basic import', () => {
    it('creates the destination repo and sets the target ref after fetching', async () => {
      // Set up source repo
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const headSha = await createSourceRepo(sourceDir);

      // Create bundle
      const bundlePath = join(workDir, 'test.bundle');
      const bundleBytes = await createBundle(sourceDir, bundlePath);

      const artifact: GitBundleArtifact = {
        projectId: 'my-project',
        bundleFile: bundleBytes,
        targetCommits: { 'refs/heads/main': headSha },
      };

      const checkpoint = makeCheckpoint('my-project', { 'refs/heads/main': headSha });
      const descriptor = makeDescriptor([checkpoint]);
      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());

      const result = await importer.importBundles([artifact], descriptor, ledger);

      expect(result.imported).toEqual(['my-project']);
      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);

      // Verify the ref was set correctly in the bare repo
      const repoPath = join(localReposBase, 'my-project.git');
      const actualSha = await resolveRef(repoPath, 'refs/heads/main');
      expect(actualSha).toBe(headSha);
    });

    it('records IMPORTED in the ledger after a successful import', async () => {
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const headSha = await createSourceRepo(sourceDir);

      const bundlePath = join(workDir, 'test.bundle');
      const bundleBytes = await createBundle(sourceDir, bundlePath);

      const artifact: GitBundleArtifact = {
        projectId: 'my-project',
        bundleFile: bundleBytes,
        targetCommits: { 'refs/heads/main': headSha },
      };

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      await importer.importBundles(
        [artifact],
        makeDescriptor([makeCheckpoint('my-project', { 'refs/heads/main': headSha })]),
        ledger,
      );

      expect(ledger.getState('my-project')).toBe('IMPORTED');
    });

    it('the destination bare repo directory is created', async () => {
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const headSha = await createSourceRepo(sourceDir);

      const bundlePath = join(workDir, 'test.bundle');
      const bundleBytes = await createBundle(sourceDir, bundlePath);

      const artifact: GitBundleArtifact = {
        projectId: 'my-project',
        bundleFile: bundleBytes,
        targetCommits: { 'refs/heads/main': headSha },
      };

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      await importer.importBundles(
        [artifact],
        makeDescriptor([makeCheckpoint('my-project', { 'refs/heads/main': headSha })]),
        ledger,
      );

      const repoPath = join(localReposBase, 'my-project.git');
      const stats = await stat(repoPath);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Re-import skip: already in ledger → PRESENT, added to skipped
  // -------------------------------------------------------------------------
  describe('ledger skip (Requirement 6.2)', () => {
    it('skips a bundle already recorded as IMPORTED in the ledger', async () => {
      const artifact: GitBundleArtifact = {
        projectId: 'already-done',
        bundleFile: Buffer.from('fake-bundle'),
        targetCommits: { 'refs/heads/main': 'abc123' },
      };

      const ledger = new ImportLedgerService('bundle-001');
      ledger.record('already-done', 'IMPORTED');  // pre-record as done

      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles(
        [artifact],
        makeDescriptor([makeCheckpoint('already-done', { 'refs/heads/main': 'abc123' })]),
        ledger,
      );

      expect(result.skipped).toEqual(['already-done']);
      expect(result.imported).toEqual([]);
      expect(result.failed).toEqual([]);
      // ledger state should now be PRESENT
      expect(ledger.getState('already-done')).toBe('PRESENT');
    });

    it('skips a bundle already recorded as PRESENT in the ledger', async () => {
      const artifact: GitBundleArtifact = {
        projectId: 'already-present',
        bundleFile: Buffer.from('fake-bundle'),
        targetCommits: { 'refs/heads/main': 'abc123' },
      };

      const ledger = new ImportLedgerService('bundle-001');
      ledger.record('already-present', 'PRESENT');

      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles(
        [artifact],
        makeDescriptor([makeCheckpoint('already-present', { 'refs/heads/main': 'abc123' })]),
        ledger,
      );

      expect(result.skipped).toEqual(['already-present']);
      expect(result.imported).toEqual([]);
      expect(result.failed).toEqual([]);
    });

    it('does not attempt to create a repo for a skipped bundle', async () => {
      // Use a localReposBase that does NOT exist — would fail if repo creation is attempted
      const nonExistentBase = join(workDir, 'does-not-exist', 'repos');
      const config = makeConfig({ localReposBase: nonExistentBase });

      const artifact: GitBundleArtifact = {
        projectId: 'skipped-project',
        bundleFile: Buffer.from('fake'),
        targetCommits: {},
      };

      const ledger = new ImportLedgerService('bundle-001');
      ledger.record('skipped-project', 'IMPORTED');

      const importer = new GitImporter(config);
      const result = await importer.importBundles(
        [artifact],
        makeDescriptor([makeCheckpoint('skipped-project', {})]),
        ledger,
      );

      expect(result.skipped).toEqual(['skipped-project']);
      expect(result.failed).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Rollback: failure during apply restores pre-fetch refs (Requirement 3.5)
  // -------------------------------------------------------------------------
  describe('rollback on failure (Requirements 3.5, 6.3, 6.5)', () => {
    it('restores pre-fetch refs when given an invalid bundle', async () => {
      // First, successfully import a project to establish a known ref state
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const initialSha = await createSourceRepo(sourceDir);

      const bundlePath = join(workDir, 'initial.bundle');
      const bundleBytes = await createBundle(sourceDir, bundlePath);

      const initialArtifact: GitBundleArtifact = {
        projectId: 'rollback-project',
        bundleFile: bundleBytes,
        targetCommits: { 'refs/heads/main': initialSha },
      };
      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      await importer.importBundles(
        [initialArtifact],
        makeDescriptor([makeCheckpoint('rollback-project', { 'refs/heads/main': initialSha })]),
        ledger,
      );

      const repoPath = join(localReposBase, 'rollback-project.git');

      // Capture the ref state after successful first import
      const refsAfterFirstImport = await getAllRefs(repoPath);
      expect(refsAfterFirstImport.get('refs/heads/main')).toBe(initialSha);

      // Now attempt to apply an invalid bundle (corrupt bytes)
      const corruptArtifact: GitBundleArtifact = {
        projectId: 'rollback-project',
        bundleFile: Buffer.from('this is not a valid git bundle at all'),
        targetCommits: { 'refs/heads/main': 'deadbeef00000000000000000000000000000000' },
      };
      // Use a fresh ledger so the project is not marked as completed
      const ledger2 = new ImportLedgerService('bundle-002');
      const result = await importer.importBundles(
        [corruptArtifact],
        makeDescriptor(
          [makeCheckpoint('rollback-project', { 'refs/heads/main': 'deadbeef00000000000000000000000000000000' })],
          { bundleId: 'bundle-002' },
        ),
        ledger2,
      );

      // Import should have failed
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]?.itemId).toBe('rollback-project');
      expect(result.imported).toEqual([]);

      // Refs should be restored to pre-fetch state (Requirement 3.5)
      const refsAfterFailure = await getAllRefs(repoPath);
      expect(refsAfterFailure.get('refs/heads/main')).toBe(initialSha);
    });

    it('records FAILED in the ledger when apply fails', async () => {
      // Set up a destination repo first (so repo creation succeeds)
      const repoPath = join(localReposBase, 'fail-project.git');
      await execAsync(`git init --bare "${repoPath}"`);

      const corruptArtifact: GitBundleArtifact = {
        projectId: 'fail-project',
        bundleFile: Buffer.from('corrupt bundle data'),
        targetCommits: {},
      };

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      await importer.importBundles(
        [corruptArtifact],
        makeDescriptor([makeCheckpoint('fail-project', {})]),
        ledger,
      );

      expect(ledger.getState('fail-project')).toBe('FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // 4. Repo creation failure: skip + report + continue (Requirement 3.6)
  // -------------------------------------------------------------------------
  describe('repo creation failure isolation (Requirement 3.6)', () => {
    it('skips a project when repo creation fails but continues with others', async () => {
      // One valid project
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const headSha = await createSourceRepo(sourceDir);

      const bundlePath = join(workDir, 'valid.bundle');
      const validBytes = await createBundle(sourceDir, bundlePath);

      const validArtifact: GitBundleArtifact = {
        projectId: 'valid-project',
        bundleFile: validBytes,
        targetCommits: { 'refs/heads/main': headSha },
      };

      // Use a localReposBase that is a FILE (not a dir) so mkdir fails for one project.
      // We do this by pre-creating a file at the path where the bad project's repo would go.
      const { writeFile: wf } = await import('fs/promises');
      await wf(join(localReposBase, 'bad-project.git'), 'I am a file, not a directory');

      const badArtifact: GitBundleArtifact = {
        projectId: 'bad-project',
        bundleFile: Buffer.from('anything'),
        targetCommits: {},
      };

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles(
        [badArtifact, validArtifact],
        makeDescriptor([
          makeCheckpoint('bad-project', {}),
          makeCheckpoint('valid-project', { 'refs/heads/main': headSha }),
        ]),
        ledger,
      );

      // bad-project should fail (or be reported), valid-project should succeed
      expect(result.imported).toContain('valid-project');
      expect(result.failed.map((f) => f.itemId)).toContain('bad-project');
    });
  });

  // -------------------------------------------------------------------------
  // 5. History retention: applying incremental bundle retains prior history
  // -------------------------------------------------------------------------
  describe('history retention (Requirement 3.3)', () => {
    it('retains previously imported commits when applying a second bundle', async () => {
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));

      // Create initial commit and bundle
      const sha1 = await createSourceRepo(sourceDir);
      const bundle1Path = join(workDir, 'bundle1.bundle');
      const bundle1Bytes = await createBundle(sourceDir, bundle1Path);

      // Import first bundle
      const artifact1: GitBundleArtifact = {
        projectId: 'history-project',
        bundleFile: bundle1Bytes,
        targetCommits: { 'refs/heads/main': sha1 },
      };
      const ledger1 = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      await importer.importBundles(
        [artifact1],
        makeDescriptor([makeCheckpoint('history-project', { 'refs/heads/main': sha1 })]),
        ledger1,
      );

      // Add a second commit and create a new full bundle
      const sha2 = await addCommit(sourceDir, 'second commit');
      const bundle2Path = join(workDir, 'bundle2.bundle');
      const bundle2Bytes = await createBundle(sourceDir, bundle2Path);

      // Import second bundle (fresh ledger simulates a second run)
      const artifact2: GitBundleArtifact = {
        projectId: 'history-project',
        bundleFile: bundle2Bytes,
        targetCommits: { 'refs/heads/main': sha2 },
      };
      const ledger2 = new ImportLedgerService('bundle-002');
      const result = await importer.importBundles(
        [artifact2],
        makeDescriptor(
          [makeCheckpoint('history-project', { 'refs/heads/main': sha2 })],
          { bundleId: 'bundle-002' },
        ),
        ledger2,
      );

      expect(result.imported).toEqual(['history-project']);

      const repoPath = join(localReposBase, 'history-project.git');

      // The ref should point to the latest commit
      const latestSha = await resolveRef(repoPath, 'refs/heads/main');
      expect(latestSha).toBe(sha2);

      // The initial commit must still be reachable (history retained)
      const logOutput = await git(['log', '--format=%H', 'refs/heads/main'], repoPath);
      const commits = logOutput.split('\n').filter(Boolean);
      expect(commits).toContain(sha1);
      expect(commits).toContain(sha2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Multiple bundles — isolation between projects
  // -------------------------------------------------------------------------
  describe('multiple bundles', () => {
    it('imports multiple valid bundles independently', async () => {
      const source1 = join(workDir, 'source1');
      const source2 = join(workDir, 'source2');
      const { mkdir } = await import('fs/promises');
      await mkdir(source1);
      await mkdir(source2);

      const sha1 = await createSourceRepo(source1);
      const sha2 = await createSourceRepo(source2);

      const b1Path = join(workDir, 'b1.bundle');
      const b2Path = join(workDir, 'b2.bundle');
      const bytes1 = await createBundle(source1, b1Path);
      const bytes2 = await createBundle(source2, b2Path);

      const artifacts: GitBundleArtifact[] = [
        { projectId: 'proj-1', bundleFile: bytes1, targetCommits: { 'refs/heads/main': sha1 } },
        { projectId: 'proj-2', bundleFile: bytes2, targetCommits: { 'refs/heads/main': sha2 } },
      ];

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles(
        artifacts,
        makeDescriptor([
          makeCheckpoint('proj-1', { 'refs/heads/main': sha1 }),
          makeCheckpoint('proj-2', { 'refs/heads/main': sha2 }),
        ]),
        ledger,
      );

      expect(result.imported).toEqual(expect.arrayContaining(['proj-1', 'proj-2']));
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);

      // Both repos should have the correct ref
      const ref1 = await resolveRef(join(localReposBase, 'proj-1.git'), 'refs/heads/main');
      const ref2 = await resolveRef(join(localReposBase, 'proj-2.git'), 'refs/heads/main');
      expect(ref1).toBe(sha1);
      expect(ref2).toBe(sha2);
    });

    it('failure of one bundle does not prevent others from being processed', async () => {
      const sourceDir = join(workDir, 'source');
      await import('fs/promises').then(({ mkdir }) => mkdir(sourceDir));
      const headSha = await createSourceRepo(sourceDir);

      const bundlePath = join(workDir, 'good.bundle');
      const goodBytes = await createBundle(sourceDir, bundlePath);

      const artifacts: GitBundleArtifact[] = [
        {
          projectId: 'bad-bundle',
          bundleFile: Buffer.from('not a bundle'),
          targetCommits: {},
        },
        {
          projectId: 'good-bundle',
          bundleFile: goodBytes,
          targetCommits: { 'refs/heads/main': headSha },
        },
      ];

      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles(
        artifacts,
        makeDescriptor([
          makeCheckpoint('bad-bundle', {}),
          makeCheckpoint('good-bundle', { 'refs/heads/main': headSha }),
        ]),
        ledger,
      );

      expect(result.imported).toContain('good-bundle');
      expect(result.failed.map((f) => f.itemId)).toContain('bad-bundle');
    });

    it('returns empty result for empty input', async () => {
      const ledger = new ImportLedgerService('bundle-001');
      const importer = new GitImporter(makeConfig());
      const result = await importer.importBundles([], makeDescriptor([]), ledger);

      expect(result.imported).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.failed).toEqual([]);
    });
  });
});
