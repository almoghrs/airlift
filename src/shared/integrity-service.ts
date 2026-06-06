/**
 * IntegrityService — SHA-256 integrity computation and verification for Transfer_Bundle contents.
 *
 * The canonical serialization covers:
 *   1. Every GitBundleArtifact, sorted by projectId:
 *      - projectId (UTF-8)
 *      - bundleFile bytes
 *      - sourceCommit (UTF-8, empty string when absent)
 *      - targetCommits as JSON with keys sorted (UTF-8)
 *   2. Every PackageArtifact, sorted by "<ecosystem>:<coordinates>@<version>":
 *      - ref key (UTF-8)
 *      - fileBytes
 *   3. Descriptor metadata (Omit<BundleDescriptor, 'integrityValue' | 'integrityAlgorithm'>)
 *      as JSON.stringify with recursively sorted keys (UTF-8).
 *
 * The integrity value field itself is explicitly excluded from its own computation
 * (Requirement 2.3, 2.4).
 *
 * Requirements: 2.3, 2.4
 */

import { createHash } from 'crypto';
import type { BundleDescriptor, GitBundleArtifact, PackageArtifact } from '../types/index.js';

// ---------------------------------------------------------------------------
// BundleContents — the data over which integrity is computed
// ---------------------------------------------------------------------------

/**
 * The data scope over which the SHA-256 integrity value is computed.
 * The descriptor metadata intentionally omits integrityValue and
 * integrityAlgorithm so that the hash can be embedded after computation
 * without circularity.
 */
export interface BundleContents {
  gitBundles: GitBundleArtifact[];
  packages: PackageArtifact[];
  /**
   * Descriptor metadata EXCLUDING the integrityValue and integrityAlgorithm
   * fields. This prevents a chicken-and-egg problem when embedding the hash.
   */
  descriptorMeta: Omit<BundleDescriptor, 'integrityValue' | 'integrityAlgorithm'>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sort an object's keys so that JSON.stringify produces a
 * deterministic output regardless of insertion order.
 */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortObjectKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Produce a deterministic JSON string by recursively sorting object keys.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

/**
 * Derive the sort key for a PackageArtifact: "<ecosystem>:<coordinates>@<version>".
 */
function packageSortKey(pkg: PackageArtifact): string {
  const { ecosystem, coordinates, version } = pkg.ref;
  return `${ecosystem}:${coordinates}@${version}`;
}

// ---------------------------------------------------------------------------
// IntegrityService
// ---------------------------------------------------------------------------

/**
 * Computes and verifies the SHA-256 integrity value for Transfer_Bundle contents.
 *
 * Canonical serialization order is:
 *   git bundles (sorted by projectId) → packages (sorted by eco:coord@ver) → descriptor meta
 *
 * This order is stable and deterministic across machines and runs.
 */
export class IntegrityService {
  /**
   * Compute the SHA-256 digest over the canonical serialization of `contents`.
   * Returns the digest as a lowercase hex string.
   */
  compute(contents: BundleContents): string {
    const hash = createHash('sha256');

    // --- 1. Git bundles, sorted by projectId ---
    const sortedGitBundles = [...contents.gitBundles].sort((a, b) =>
      a.projectId.localeCompare(b.projectId),
    );

    for (const bundle of sortedGitBundles) {
      // projectId
      hash.update(bundle.projectId, 'utf8');
      // bundleFile bytes
      hash.update(bundle.bundleFile);
      // sourceCommit (empty string when absent — V1 bundles have no source commit)
      hash.update(bundle.sourceCommit ?? '', 'utf8');
      // targetCommits as stable JSON (keys sorted for determinism)
      hash.update(stableJson(bundle.targetCommits), 'utf8');
    }

    // --- 2. Package artifacts, sorted by "<ecosystem>:<coordinates>@<version>" ---
    const sortedPackages = [...contents.packages].sort((a, b) =>
      packageSortKey(a).localeCompare(packageSortKey(b)),
    );

    for (const pkg of sortedPackages) {
      // ref as "<ecosystem>:<coordinates>@<version>"
      hash.update(packageSortKey(pkg), 'utf8');
      // raw file bytes
      hash.update(pkg.fileBytes);
    }

    // --- 3. Descriptor metadata (stable JSON, integrityValue excluded) ---
    hash.update(stableJson(contents.descriptorMeta), 'utf8');

    return hash.digest('hex');
  }

  /**
   * Re-compute the integrity value over `contents` and compare it to `recorded`.
   * Returns true when they match (bundle is intact), false otherwise.
   */
  verify(contents: BundleContents, recorded: string): boolean {
    return this.compute(contents) === recorded;
  }
}
