/**
 * GitImporter — applies git bundles to destination bare repositories.
 *
 * For each GitBundleArtifact:
 *   1. Check ledger — skip if already completed (IMPORTED or PRESENT)
 *   2. Create destination bare repo if it doesn't exist (skip+report on failure)
 *   3. Write bundle bytes to a temp file
 *   4. `git fetch <bundleFile> '+refs/*:refs/*'` into the bare repo, retaining existing refs
 *   5. If fetch succeeded: set each ref to its target commit from the descriptor
 *   6. If any ref-set fails: rollback all refs to pre-fetch state, report, continue
 *   7. Record IMPORTED or FAILED in ledger
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.2, 6.3, 6.5
 */

import { exec } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { BundleDescriptor, GitBundleArtifact, ItemFailure } from '../types/index.js';
import type { ImportLedgerService } from './import-ledger.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface GitImportResult {
  /** projectIds successfully imported */
  imported: string[];
  /** projectIds already in ledger (IMPORTED or PRESENT) */
  skipped: string[];
  /** projectIds that failed with reasons */
  failed: ItemFailure[];
}

export interface GitLabConfig {
  /** e.g. "https://gitlab.example.com" */
  baseUrl: string;
  /** Personal access token for API + git auth */
  token: string;
  /** GitLab namespace/group (e.g. "my-org") */
  namespace: string;
  /** Local directory where destination repos are mirrored as bare repos */
  localReposBase: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in the given working directory.
 * Returns stdout on success; throws on non-zero exit.
 */
async function runGit(args: string[], cwd: string): Promise<string> {
  const cmd = `git ${args.map((a) => `"${a}"`).join(' ')}`;
  const { stdout } = await execAsync(cmd, { cwd });
  return stdout;
}

/**
 * Capture a snapshot of all refs in a bare repo via `git show-ref`.
 * Returns a map of refName → sha.
 * Returns an empty map when no refs exist (empty repo).
 */
async function captureRefs(repoPath: string): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  try {
    const output = await runGit(['show-ref'], repoPath);
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      const sha = trimmed.slice(0, spaceIdx);
      const ref = trimmed.slice(spaceIdx + 1);
      if (sha && ref) {
        refs.set(ref, sha);
      }
    }
  } catch {
    // `git show-ref` exits with code 1 when there are no refs — treat as empty
  }
  return refs;
}

/**
 * Restore refs to a previously captured snapshot.
 * Refs that did not exist before are deleted; existing refs are reset.
 */
async function restoreRefs(
  repoPath: string,
  preFetchRefs: Map<string, string>,
  currentRefs: Map<string, string>,
): Promise<void> {
  // Delete refs that didn't exist before the fetch
  for (const [ref] of currentRefs) {
    if (!preFetchRefs.has(ref)) {
      try {
        await runGit(['update-ref', '-d', ref], repoPath);
      } catch {
        // Best-effort rollback; ignore individual failures
      }
    }
  }
  // Restore refs that existed before the fetch
  for (const [ref, sha] of preFetchRefs) {
    try {
      await runGit(['update-ref', ref, sha], repoPath);
    } catch {
      // Best-effort rollback; ignore individual failures
    }
  }
}

// ---------------------------------------------------------------------------
// GitImporter
// ---------------------------------------------------------------------------

export class GitImporter {
  constructor(private readonly config: GitLabConfig) {}

  /**
   * Import all git bundles from a transfer bundle into the destination.
   *
   * Per-bundle logic (isolated: failure of one does not stop others):
   *   1. Ledger check — skip if IMPORTED or PRESENT
   *   2. Ensure destination bare repo exists (create if absent; skip+report on failure)
   *   3. Write bundle bytes to temp file
   *   4. `git fetch <bundleFile> '+refs/*:refs/*'` retaining existing history
   *   5. Set refs to descriptor's target commits (atomically after full fetch)
   *   6. Rollback on failure; record result in ledger
   */
  async importBundles(
    gitBundles: GitBundleArtifact[],
    descriptor: BundleDescriptor,
    ledger: ImportLedgerService,
  ): Promise<GitImportResult> {
    const result: GitImportResult = {
      imported: [],
      skipped: [],
      failed: [],
    };

    for (const bundle of gitBundles) {
      const { projectId } = bundle;

      // ------------------------------------------------------------------ 1.
      // Ledger check — skip already-completed items (Requirement 6.2)
      // ------------------------------------------------------------------ 1.
      if (ledger.isCompleted(projectId)) {
        ledger.record(projectId, 'PRESENT');
        result.skipped.push(projectId);
        continue;
      }

      const repoPath = join(this.config.localReposBase, `${projectId}.git`);

      // ------------------------------------------------------------------ 2.
      // Ensure destination repo exists (Requirement 3.2, 3.6)
      // ------------------------------------------------------------------ 2.
      const repoCreated = await this.ensureRepo(repoPath);
      if (!repoCreated.ok) {
        const reason = repoCreated.reason;
        ledger.record(projectId, 'FAILED');
        result.failed.push({ itemId: projectId, reason });
        continue;
      }

      // ------------------------------------------------------------------ 3-6.
      // Write bundle to temp, fetch, set refs, rollback on failure
      // ------------------------------------------------------------------ 3-6.
      const applyResult = await this.applyBundle(bundle, descriptor, repoPath);

      if (applyResult.ok) {
        ledger.record(projectId, 'IMPORTED');
        result.imported.push(projectId);
      } else {
        ledger.record(projectId, 'FAILED');
        result.failed.push({ itemId: projectId, reason: applyResult.reason });
      }
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Ensure a bare git repo exists at `repoPath`.
   * Creates it with `git init --bare` if absent.
   * Returns `{ ok: true }` on success or `{ ok: false, reason }` on failure.
   */
  private async ensureRepo(
    repoPath: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Check if the directory already exists by trying to run git show-ref
    // (or any git command) inside it. A simpler check is to see if the
    // directory exists at all.
    try {
      await mkdir(repoPath, { recursive: true });
      // Check if this is already a git repo
      try {
        await runGit(['rev-parse', '--git-dir'], repoPath);
        // Already a valid git repo
        return { ok: true };
      } catch {
        // Not a git repo yet — initialise it
        await runGit(['init', '--bare', repoPath], tmpdir());
        return { ok: true };
      }
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to create repository at ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Apply a single git bundle to the bare repo at `repoPath`.
   *
   * Steps:
   *   1. Capture pre-fetch ref state (for rollback)
   *   2. Write bundle bytes to a temp file
   *   3. `git fetch <bundleFile> '+refs/*:refs/*'`
   *   4. On fetch success: set target refs from the descriptor
   *   5. On any failure: rollback refs to pre-fetch state
   */
  private async applyBundle(
    bundle: GitBundleArtifact,
    descriptor: BundleDescriptor,
    repoPath: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // -------- Capture pre-fetch refs (for rollback, Requirement 3.5) --------
    const preFetchRefs = await captureRefs(repoPath);

    // -------- Write bundle to temp file --------
    let tmpDir: string;
    let bundlePath: string;
    try {
      tmpDir = await mkdtemp(join(tmpdir(), 'git-importer-'));
      bundlePath = join(tmpDir, `${bundle.projectId}.bundle`);
      await writeFile(bundlePath, bundle.bundleFile);
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to write bundle to temp file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      // -------- Step 3: git fetch (retains existing history, Requirement 3.3) --------
      try {
        await runGit(['fetch', bundlePath, '+refs/*:refs/*'], repoPath);
      } catch (err) {
        // Fetch failed — rollback and report (Requirement 3.5)
        const currentRefs = await captureRefs(repoPath);
        await restoreRefs(repoPath, preFetchRefs, currentRefs);
        return {
          ok: false,
          reason: `git fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // -------- Step 4: Set refs to target commits (Requirement 3.4, 6.3) --------
      // Only do this after full successful fetch. If any ref-set fails, rollback all.
      const targetCommits = bundle.targetCommits;
      const checkpoint = descriptor.projectCheckpoints.find(
        (cp) => cp.projectId === bundle.projectId,
      );

      // Merge target commits: prefer checkpoint (descriptor) over bundle artifact
      const refsToSet: Record<string, string> =
        checkpoint ? { ...checkpoint.gitTargetCommits } : { ...targetCommits };

      const refsSet: string[] = [];
      try {
        for (const [ref, sha] of Object.entries(refsToSet)) {
          await runGit(['update-ref', ref, sha], repoPath);
          refsSet.push(ref);
        }
      } catch (err) {
        // Ref-setting failed — rollback to pre-fetch state (Requirement 3.5, 6.5)
        const currentRefs = await captureRefs(repoPath);
        await restoreRefs(repoPath, preFetchRefs, currentRefs);
        return {
          ok: false,
          reason: `Failed to set refs after fetch: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return { ok: true };
    } finally {
      // Clean up temp dir
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
