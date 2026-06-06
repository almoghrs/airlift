/**
 * PackingStrategy interface and FullSnapshotStrategy (V1).
 *
 * The PackingStrategy is the single seam between V1 and V2. Everything
 * downstream of it — BundleWriter, BundleReader, Importer, reporting — is
 * version-agnostic.
 *
 * Requirements: 7.1, 7.2, 8.1, 8.2
 */

import type { PackageFilter } from '../shared/ecosystem-adapter.js';
import type { SyncState, TrackedProject } from '../types/index.js';
import type { GitPackerBaseline } from './git-packer.js';

// ---------------------------------------------------------------------------
// PackingStrategy interface
// ---------------------------------------------------------------------------

/**
 * Defines the packing strategy for a given Sync_Run.
 * V1 uses FullSnapshotStrategy; V2 uses IncrementalStrategy (task 14.2).
 */
export interface PackingStrategy {
  /** The delivery version this strategy produces. */
  readonly name: 'V1' | 'V2';

  /**
   * Determine the git packing baseline for a given project.
   * FullSnapshotStrategy always returns `{ kind: 'FULL' }`.
   * IncrementalStrategy (V2) consults SyncState.
   *
   * @param project   The project being packed.
   * @param syncState Optional Sync_State for V2; ignored by V1.
   */
  gitBaseline(project: TrackedProject, syncState?: SyncState): GitPackerBaseline;

  /**
   * Returns a filter function to apply during package resolution.
   * FullSnapshotStrategy returns a filter that includes all packages.
   * IncrementalStrategy (V2) returns a filter that excludes already-packed versions.
   *
   * @param project   The project being packed.
   * @param syncState Optional Sync_State for V2; ignored by V1.
   */
  packageFilter(project: TrackedProject, syncState?: SyncState): PackageFilter;
}

// ---------------------------------------------------------------------------
// FullSnapshotStrategy (V1)
// ---------------------------------------------------------------------------

/**
 * V1 full-snapshot strategy.
 *
 * Always packs everything — no change tracking, no Sync_State consultation.
 * On every Sync_Run:
 *   - `gitBaseline` returns `{ kind: 'FULL' }` so GitPacker runs `git bundle create --all`.
 *   - `packageFilter` returns an include-all predicate so DependencyResolver
 *     resolves the full transitive closure.
 *
 * AC 7.1: every Sync_Run produces a Git_Bundle with full history.
 * AC 7.2: a bundle is produced on every run regardless of changes.
 * AC 8.1: all Package_Versions available on the Source_Artifactory are identified.
 * AC 8.2: every identified version is included.
 */
export class FullSnapshotStrategy implements PackingStrategy {
  readonly name = 'V1' as const;

  /**
   * Always returns a FULL baseline.
   * syncState is intentionally ignored — V1 never consults state.
   */
  gitBaseline(_project: TrackedProject, _syncState?: SyncState): GitPackerBaseline {
    return { kind: 'FULL' };
  }

  /**
   * Returns an include-all filter.
   * syncState is intentionally ignored — V1 packs everything.
   */
  packageFilter(_project: TrackedProject, _syncState?: SyncState): PackageFilter {
    // Include-all: V1 packs every package version regardless of prior state
    return () => true;
  }
}
