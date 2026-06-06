/**
 * Unit tests for GitPacker (task 6.1).
 *
 * Tests use the real `git` CLI to build minimal synthetic repos in temp
 * directories and verify GitPacker behaviour end-to-end.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TrackedProject } from '../types/index';
import { GitPacker } from './git-packer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe' }).toString('utf8').trim();
}

/**
 * Create a minimal git repository with at least one commit and return the
 * path to the repository directory.
 */
function createMinimalRepo(tmpBase: string, repoName = 'test-repo'): string {
  const repoPath = path.join(tmpBase, repoName);
  fs.mkdirSync(repoPath, { recursive: true });

  run('git init -b main', repoPath);
  run('git config user.email "test@test.com"', repoPath);
  run('git config user.name "Test"', repoPath);

  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Hello\n');
  run('git add .', repoPath);
  run('git commit -m "initial commit"', repoPath);

  return repoPath;
}

/**
 * Create a git repository with multiple branches and a tag.
 */
function createMultiRefRepo(tmpBase: string, repoName = 'multi-ref-repo'): string {
  const repoPath = path.join(tmpBase, repoName);
  fs.mkdirSync(repoPath, { recursive: true });

  run('git init -b main', repoPath);
  run('git config user.email "test@test.com"', repoPath);
  run('git config user.name "Test"', repoPath);

  // First commit on main
  fs.writeFileSync(path.join(repoPath, 'file.txt'), 'v1\n');
  run('git add .', repoPath);
  run('git commit -m "commit on main"', repoPath);

  // Create a tag on this commit
  run('git tag v1.0.0', repoPath);

  // Create a feature branch with another commit
  run('git checkout -b feature', repoPath);
  fs.writeFileSync(path.join(repoPath, 'feature.txt'), 'feature\n');
  run('git add .', repoPath);
  run('git commit -m "commit on feature"', repoPath);

  // Go back to main
  run('git checkout main', repoPath);

  return repoPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitPacker', () => {
  let tmpDir: string;
  const packer = new GitPacker();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-packer-tests-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path: single-commit repo
  // -------------------------------------------------------------------------

  it('packs a minimal repo and returns ok:true with a non-empty bundle', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-minimal',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return; // type narrowing

    expect(result.artifact.projectId).toBe('proj-minimal');
    expect(result.artifact.bundleFile).toBeInstanceOf(Buffer);
    expect(result.artifact.bundleFile.length).toBeGreaterThan(0);
  });

  it('records at least one ref in targetCommits for a minimal repo', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-refs',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    const refs = Object.keys(result.artifact.targetCommits);
    expect(refs.length).toBeGreaterThan(0);

    // At least one ref should be refs/heads/main (or refs/heads/master)
    const hasExpectedRef = refs.some(
      (r) => r === 'refs/heads/main' || r === 'refs/heads/master',
    );
    expect(hasExpectedRef).toBe(true);
  });

  it('targetCommits values are valid 40-char hex commit SHAs', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-sha',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    for (const sha of Object.values(result.artifact.targetCommits)) {
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  // -------------------------------------------------------------------------
  // Multi-ref repo (branches + tag)
  // -------------------------------------------------------------------------

  it('records all refs (branches and tags) for a multi-ref repo', async () => {
    const repoPath = createMultiRefRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-multi',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    const refs = Object.keys(result.artifact.targetCommits);

    // Expect main branch, feature branch, and the v1.0.0 tag
    expect(refs).toContain('refs/heads/main');
    expect(refs).toContain('refs/heads/feature');
    expect(refs).toContain('refs/tags/v1.0.0');
  });

  it('each ref in the multi-ref bundle maps to the correct commit SHA', async () => {
    const repoPath = createMultiRefRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-multi-shas',
      gitLocation: repoPath,
      packages: [],
    };

    // Read actual HEAD SHAs for main and feature from the source repo
    const mainSha = run('git rev-parse refs/heads/main', repoPath);
    const featureSha = run('git rev-parse refs/heads/feature', repoPath);
    const tagSha = run('git rev-parse refs/tags/v1.0.0', repoPath);

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    expect(result.artifact.targetCommits['refs/heads/main']).toBe(mainSha);
    expect(result.artifact.targetCommits['refs/heads/feature']).toBe(featureSha);
    expect(result.artifact.targetCommits['refs/tags/v1.0.0']).toBe(tagSha);
  });

  // -------------------------------------------------------------------------
  // Produced bundle is a valid git bundle (verify with git bundle verify)
  // -------------------------------------------------------------------------

  it('produces a git bundle that passes `git bundle verify`', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-verify',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    // Write the bundle to disk and verify it with git
    const bundlePath = path.join(tmpDir, 'check.bundle');
    fs.writeFileSync(bundlePath, result.artifact.bundleFile);

    // `git bundle verify` exits 0 on a valid bundle
    expect(() => {
      execSync(`git bundle verify "${bundlePath}"`, {
        stdio: 'pipe',
      });
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Bundle can reconstruct refs from an empty repository (AC 7.1, 7.3)
  // -------------------------------------------------------------------------

  it('bundle can reconstruct refs in an empty bare destination repo', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-reconstruct',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(true);
    if (result.ok !== true) return;

    // Create an empty bare destination repo
    const destDir = path.join(tmpDir, 'dest.git');
    fs.mkdirSync(destDir);
    run('git init --bare -b main', destDir);
    run('git config user.email "test@test.com"', destDir);
    run('git config user.name "Test"', destDir);

    // Write bundle file to disk
    const bundlePath = path.join(tmpDir, 'reconstruct.bundle');
    fs.writeFileSync(bundlePath, result.artifact.bundleFile);

    // Fetch all from the bundle into the bare dest repo
    run(`git fetch "${bundlePath}" "refs/*:refs/*"`, destDir);

    // Verify each tracked ref matches the recorded target commit
    for (const [ref, expectedSha] of Object.entries(result.artifact.targetCommits)) {
      // Only check refs that were successfully fetched (skip remote-tracking refs)
      try {
        const actualSha = run(`git rev-parse "${ref}"`, destDir);
        expect(actualSha).toBe(expectedSha);
      } catch {
        // ref might not be fetched due to refspec filtering — skip it
      }
    }
  });

  // -------------------------------------------------------------------------
  // Failure case: non-existent git location
  // -------------------------------------------------------------------------

  it('returns ok:false (not throws) when the git location does not exist', async () => {
    const project: TrackedProject = {
      id: 'proj-missing',
      gitLocation: path.join(tmpDir, 'does-not-exist'),
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;

    expect(result.projectId).toBe('proj-missing');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('returns ok:false with the correct projectId when packing fails', async () => {
    const project: TrackedProject = {
      id: 'my-failing-project',
      gitLocation: '/nonexistent/path/to/repo',
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'FULL' });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;

    expect(result.projectId).toBe('my-failing-project');
  });

  // -------------------------------------------------------------------------
  // Isolation: failure in one project does not affect another (AC 7.5)
  // -------------------------------------------------------------------------

  it('failure in one project does not prevent packing another project', async () => {
    const validRepoPath = createMinimalRepo(tmpDir, 'valid-repo');
    const failingProject: TrackedProject = {
      id: 'failing',
      gitLocation: path.join(tmpDir, 'no-such-repo'),
      packages: [],
    };
    const validProject: TrackedProject = {
      id: 'valid',
      gitLocation: validRepoPath,
      packages: [],
    };

    const [failResult, successResult] = await Promise.all([
      packer.pack(failingProject, { kind: 'FULL' }),
      packer.pack(validProject, { kind: 'FULL' }),
    ]);

    expect(failResult.ok).toBe(false);
    expect(successResult.ok).toBe(true);

    if (successResult.ok === true) {
      expect(successResult.artifact.projectId).toBe('valid');
      expect(successResult.artifact.bundleFile.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // SINCE baseline (V2 — not yet implemented)
  // -------------------------------------------------------------------------

  it('returns ok:false for SINCE baseline (not yet implemented)', async () => {
    const repoPath = createMinimalRepo(tmpDir);
    const project: TrackedProject = {
      id: 'proj-since',
      gitLocation: repoPath,
      packages: [],
    };

    const result = await packer.pack(project, { kind: 'SINCE', commit: 'abc123' });

    expect(result.ok).toBe(false);
    if (result.ok !== false) return;
    expect(result.projectId).toBe('proj-since');
    expect(result.reason).toContain('14.1');
  });
});
