/**
 * EcosystemAdapter interface and supporting types.
 *
 * Isolates the npm/Python differences behind a single interface so that the
 * DependencyResolver, Packer, and PackageImporter can treat all ecosystems
 * uniformly.
 *
 * Requirements: 1.4, 4.2, 8.1, 8.3
 */

import type { Ecosystem, PackageRef } from '../types/index.js';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * The kind of destination Artifactory repository an adapter uploads to.
 * Maps directly to the Requirement 4.2 "ecosystem-matching repository" rule.
 */
export type TargetRepositoryKind = 'npm' | 'pypi';

/**
 * Outcome returned by EcosystemAdapter.upload.
 *
 * - `uploaded`       — the package was successfully uploaded.
 * - `already_present`— the package already existed on the destination; no upload performed.
 * - `failed`         — the upload failed; `reason` carries the human-readable explanation.
 */
export type UploadOutcome =
  | { kind: 'uploaded' }
  | { kind: 'already_present' }
  | { kind: 'failed'; reason: string };

/**
 * Returns `true` if the given PackageRef should be included in the bundle.
 * Passed into the DependencyResolver to implement V1 (include all) and V2
 * (exclude already-packed) filtering.
 */
export type PackageFilter = (ref: PackageRef) => boolean;

/**
 * Connection details for a JFrog Artifactory instance (source or destination).
 * Either `apiKey` or `username`+`password` may be supplied for authentication.
 */
export interface ArtifactoryConfig {
  /** Base URL of the Artifactory instance, e.g. "https://acme.jfrog.io/artifactory". */
  baseUrl: string;
  /** API key for token-based authentication (takes precedence over username/password). */
  apiKey?: string;
  /** Username for basic authentication. */
  username?: string;
  /** Password for basic authentication. */
  password?: string;
}

// ---------------------------------------------------------------------------
// EcosystemAdapter interface
// ---------------------------------------------------------------------------

/**
 * Pluggable adapter that encapsulates every ecosystem-specific operation.
 *
 * Implementations:
 *   - NpmAdapter    — npm packages from/to the npm Artifactory repository
 *   - PythonAdapter — Python wheels/sdists from/to the PyPI Artifactory repository
 *
 * The DependencyResolver and PackageImporter are written once against this
 * interface and delegate all ecosystem differences here.
 */
export interface EcosystemAdapter {
  /**
   * The ecosystem this adapter handles.
   * Matches the `ecosystem` field of every `PackageRef` the adapter produces.
   */
  readonly ecosystem: Ecosystem;

  /**
   * Discover all available versions for the given package coordinates from
   * Source_Artifactory.
   *
   * @param coordinates Ecosystem-qualified package identifier (e.g. npm package
   *   name or Python distribution name).
   * @returns Array of PackageRefs, one per discovered version. May be empty if
   *   the package is not found.
   */
  discoverVersions(coordinates: string): Promise<PackageRef[]>;

  /**
   * Parse the dependency list from a downloaded package file.
   *
   * For npm: reads `dependencies`, `optionalDependencies`, and
   *   `peerDependencies` from the embedded `package.json`.
   * For Python: reads `Requires-Dist` specifiers from METADATA/PKG-INFO,
   *   resolving environment markers and extras conservatively.
   *
   * @param fileBytes Raw bytes of the package file (`.tgz`, wheel, or sdist).
   * @returns Array of PackageRefs representing the declared dependencies.
   *   Returns an empty array when no dependencies are declared.
   */
  parseDependencies(fileBytes: Buffer): Promise<PackageRef[]>;

  /**
   * Download a specific package version from Source_Artifactory.
   *
   * @param ref The package version to download.
   * @returns Raw bytes of the package file.
   * @throws If the download fails or the ref is not found.
   */
  download(ref: PackageRef): Promise<Buffer>;

  /**
   * Upload a package version to Destination_Artifactory.
   *
   * Callers should apply the 300-second per-upload cap and up to 3 retry
   * attempts at the call site (PackageImporter), not inside the adapter.
   *
   * @param ref   The package version being uploaded.
   * @param fileBytes Raw bytes of the package file.
   * @returns An UploadOutcome indicating success, prior presence, or failure.
   */
  upload(ref: PackageRef, fileBytes: Buffer): Promise<UploadOutcome>;

  /**
   * The kind of destination repository this adapter uploads to.
   * Used by PackageImporter to route uploads to the correct Artifactory repo
   * (Requirement 4.2).
   */
  readonly targetRepositoryKind: TargetRepositoryKind;
}
