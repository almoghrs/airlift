/**
 * GitPacker — shells out to the native `git` CLI to produce a GitBundleArtifact
 * containing the full history of all tracked refs (V1) or incremental commits
 * since a baseline commit (V2).
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GitBundleArtifact, TrackedProject } from '../types/index';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Packing baseline consumed by GitPacker.
 * - FULL:         V1 full-history snapshot — `git bundle create <file> --all`
 * - SINCE(commit): V2 incremental — commits reachable from tracked refs
 *                  but NOT reachable from <commit> (task 14.1)
 */
export type GitPackerBaseline =
  | { kind: 'FULL' }
  | { kind: 'SINCE'; commit: string };

/**
 * Result of a single GitPacker.pack call.
 * - ok: true         → artifact is ready
 * - ok: false        → packing failed; the project is excluded from the bundle
 * - ok: 'skip'       → no new commits (V2 only); project excluded with reason
 */
export type GitPackResult =
  | { ok: true; artifact: GitBundleArtifact }
  | { ok: false; projectId: string; reason: string }
  | { ok: 'skip'; projectId: string; reason: 'no_changes' }; // V2 only

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `git log --format="%H %D" --all` output into a ref → commitSha map.
 *
 * Each line looks like:
 *   <sha> HEAD -> refs/heads/main, refs/heads/main, refs/remotes/origin/HEAD
 *
 * We keep only proper ref names (refs/heads/*, refs/tags/*, refs/remotes/*).
 * The special token "HEAD" or "HEAD -> ..." is skipped.
 */
function parseTargetCommits(logOutput: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of logOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;

    const sha = trimmed.slice(0, spaceIdx).trim();
    const decorations = trimmed.slice(spaceIdx + 1).trim();

    if (!decorations) continue;

    // Split by ", " to get individual decoration tokens
    for (const token of decorations.split(',')) {
      const t = token.trim();

      // Skip "HEAD" bare token and "HEAD -> <ref>" arrows
      if (t === 'HEAD') continue;
      if (t.startsWith('HEAD ->')) {
        // Extract the actual ref after "HEAD -> "
        const ref = t.slice('HEAD ->'.length).trim();
        if (ref.startsWith('refs/')) {
          result[ref] = sha;
        }
        continue;
      }

      if (t.startsWith('refs/')) {
        result[t] = sha;
      }
    }
  }

  return result;
}

/** Execute a command synchronously, throwing on non-zero exit. */
function run(cmd: string, cwd: string): Buffer {
  return execSync(cmd, {
    cwd,
    stdio: 'pipe',
    timeout: 300_000, // 300 s — large repos can be slow
  });
}

// ---------------------------------------------------------------------------
// GitPacker
// ---------------------------------------------------------------------------

/**
 * Packs a git repository into a GitBundleArtifact by shelling out to the
 * native `git` CLI.
 */
export class GitPacker {
  /**
   * Pack a git repository into a GitBundleArtifact.
   *
   * For V1 (FULL baseline): clones the repository bare into a temp dir,
   * runs `git bundle create <bundleFile> --all`, reads the bundle bytes, and
   * builds the targetCommits map from `git log --format="%H %D" --all`.
   *
   * For SINCE baseline (V2 — task 14.1): TODO — not yet implemented.
   *
   * On any subprocess error the method returns `{ ok: false }` rather than
   * throwing, so a failure in one project does not affect others (AC 7.5).
   *
   * @param project  The tracked project to pack.
   * @param baseline FULL for V1; SINCE(commit) for V2 incremental.
   * @returns        GitPackResult
   */
  async pack(
    project: TrackedProject,
    baseline: GitPackerBaseline,
  ): Promise<GitPackResult> {
    let tmpDir: string | undefined;

    try {
      // Create an isolated temp directory for this packing operation
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `airlift-gitpacker-${project.id}-`));

      if (baseline.kind === 'FULL') {
        return await this._packFull(project, tmpDir);
      } else {
        // TODO (task 14.1): implement SINCE(commit) incremental packing via
        //   git bundle create <file> <refs> --not <baseline.commit>
        return {
          ok: false,
          projectId: project.id,
          reason: 'SINCE baseline is not yet implemented (task 14.1)',
        };
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, projectId: project.id, reason };
    } finally {
      // Always clean up the temp directory
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; ignore errors
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: full-history packing
  // -------------------------------------------------------------------------

  private async _packFull(
    project: TrackedProject,
    tmpDir: string,
  ): Promise<GitPackResult> {
    const repoDir = path.join(tmpDir, 'repo.git');
    const bundlePath = path.join(tmpDir, 'bundle.git');

    // Clone the repository as a bare repo so we get all refs
    // `--mirror` would also work but `--bare` is sufficient and safer for
    // local paths (avoids creating remote-tracking refs we do not need)
    run(`git clone --bare -- "${project.gitLocation}" "${repoDir}"`, tmpDir);

    // Create the bundle with full history of all refs
    run(`git bundle create "${bundlePath}" --all`, repoDir);

    // Read the bundle bytes
    const bundleFile = fs.readFileSync(bundlePath);

    // Build the targetCommits map by inspecting all refs and their HEADs
    let logOutput: string;
    try {
      logOutput = run(`git log --format="%H %D" --all --no-walk=unsorted`, repoDir).toString('utf8');
    } catch {
      // Fallback: use for-each-ref which is always reliable
      logOutput = '';
    }

    // Primary: use for-each-ref for accurate ref→sha mapping
    const forEachRefOutput = run(
      `git for-each-ref --format="%(objectname) %(refname)" refs/`,
      repoDir,
    ).toString('utf8');

    const targetCommits = parseForEachRef(forEachRefOutput);

    // Fallback to log parsing if for-each-ref yielded nothing (empty repo edge case)
    if (Object.keys(targetCommits).length === 0 && logOutput) {
      const fromLog = parseTargetCommits(logOutput);
      Object.assign(targetCommits, fromLog);
    }

    return {
      ok: true,
      artifact: {
        projectId: project.id,
        bundleFile,
        targetCommits,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helper: parse `git for-each-ref` output
// ---------------------------------------------------------------------------

/**
 * Parse `git for-each-ref --format="%(objectname) %(refname)" refs/` output.
 * Each line: `<sha> <refname>`
 */
function parseForEachRef(output: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) continue;

    const sha = trimmed.slice(0, spaceIdx).trim();
    const ref = trimmed.slice(spaceIdx + 1).trim();

    if (ref.startsWith('refs/') && sha) {
      result[ref] = sha;
    }
  }

  return result;
}
