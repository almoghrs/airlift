/**
 * DependencyResolver — ecosystem-agnostic transitive closure with cycle/dedup
 * protection via a visited-set worklist algorithm.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.5, 8.6, 8.7
 */

import type { Ecosystem, PackageArtifact, PackageRef, RetrievalFailure } from '../types/index.js';
import type { EcosystemAdapter, PackageFilter } from './ecosystem-adapter.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Outcome of a single resolve() call.
 */
export interface ResolveResult {
  /** All retrieved, included package versions (deduped, at most one entry per ref). */
  included: PackageArtifact[];
  /** Versions that could not be retrieved from Source_Artifactory. */
  failures: RetrievalFailure[];
}

// ---------------------------------------------------------------------------
// DependencyResolver
// ---------------------------------------------------------------------------

/**
 * Resolves the full transitive closure of a set of root PackageRefs.
 *
 * Algorithm (worklist + visited set):
 *   1. Seed the worklist with every root that passes `filter` and hasn't been visited.
 *   2. Pop a ref from the worklist.
 *   3. If already in `visited`, skip (handles diamonds and back-edges).
 *   4. Mark it visited.
 *   5. Find the adapter for ref.ecosystem — throws clearly if none registered.
 *   6. Download via adapter.download(ref); on failure record RetrievalFailure and continue.
 *   7. On success add the PackageArtifact to `included`.
 *   8. Parse transitive deps via adapter.parseDependencies(fileBytes).
 *   9. For each dep: if filter(dep) passes AND not already visited → enqueue.
 *  10. Repeat until the worklist is empty.
 *
 * The visited key is `"${ecosystem}:${coordinates}@${version}"` (exact version strings).
 * This guarantees termination on cyclic graphs (A → B → A) and at-most-once inclusion
 * for diamond graphs (A→B, A→C, B→D, C→D).
 */
export class DependencyResolver {
  constructor(
    private readonly adapters: Map<Ecosystem, EcosystemAdapter>,
  ) {}

  /**
   * Resolve the full transitive closure of the given root package refs.
   *
   * @param roots  - Seed PackageRefs to resolve from.
   * @param filter - Injectable predicate; V1 = () => true; V2 = exclude already-packed.
   *                 Applied BEFORE downloading to avoid unnecessary network calls.
   */
  async resolve(roots: PackageRef[], filter: PackageFilter): Promise<ResolveResult> {
    const included: PackageArtifact[] = [];
    const failures: RetrievalFailure[] = [];

    // visited keys: "${ecosystem}:${coordinates}@${version}"
    const visited = new Set<string>();

    // Worklist seeded from roots that pass the filter and haven't been visited.
    const worklist: PackageRef[] = [];

    for (const root of roots) {
      const key = visitedKey(root);
      if (filter(root) && !visited.has(key)) {
        worklist.push(root);
      }
    }

    while (worklist.length > 0) {
      // Pop from the front (BFS) — order doesn't affect correctness but is
      // more predictable for test assertions.
      const ref = worklist.shift()!;

      const key = visitedKey(ref);

      // Skip if already processed (handles diamonds: same dep via multiple paths).
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      // Resolve the adapter; throw clearly if the ecosystem is unknown.
      const adapter = this.adapters.get(ref.ecosystem);
      if (adapter === undefined) {
        throw new Error(
          `DependencyResolver: no adapter registered for ecosystem "${ref.ecosystem}" ` +
          `(needed for ${ref.coordinates}@${ref.version})`,
        );
      }

      // Attempt to download the package file.
      let fileBytes: Buffer;
      try {
        fileBytes = await adapter.download(ref);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        failures.push({ ref, reason });
        // Retrieval failure is non-blocking — continue with remaining worklist items.
        continue;
      }

      // Successful download — add to included set.
      included.push({ ref, fileBytes });

      // Parse transitive dependencies and enqueue those that pass the filter
      // and haven't been visited yet.
      let deps: PackageRef[];
      try {
        deps = await adapter.parseDependencies(fileBytes);
      } catch {
        // If dependency parsing fails, treat as no dependencies declared
        // (conservative: we still included the package itself).
        deps = [];
      }

      for (const dep of deps) {
        const depKey = visitedKey(dep);
        if (filter(dep) && !visited.has(depKey)) {
          worklist.push(dep);
        }
      }
    }

    return { included, failures };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stable, unique string key for a PackageRef in the visited set.
 * Format: "<ecosystem>:<coordinates>@<version>"
 */
function visitedKey(ref: PackageRef): string {
  return `${ref.ecosystem}:${ref.coordinates}@${ref.version}`;
}
