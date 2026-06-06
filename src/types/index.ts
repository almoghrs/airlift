/**
 * Core data model types and interfaces for the Airgap Package Sync Pipeline.
 *
 * Requirements: 1.1, 2.2, 5.1, 5.2, 5.5
 */

// ---------------------------------------------------------------------------
// Primitive union / enum types
// ---------------------------------------------------------------------------

/** Supported package ecosystems (Requirement 1.4). */
export type Ecosystem = 'npm' | 'Python';

/** Manifest validation outcome (Requirement 1.5). */
export type ManifestStatus = 'VALID' | 'INVALID';

/** Delivery version of the pipeline. */
export type DeliveryVersion = 'V1' | 'V2';

/** Algorithm used for bundle integrity computation (Requirement 2.3). */
export type IntegrityAlgorithm = 'SHA-256';

/**
 * State of a single item in the Import Ledger (Requirement 6.2).
 * - IMPORTED: successfully uploaded/applied during this import run
 * - PRESENT:  already present on the destination; skipped
 * - FAILED:   attempted but could not be imported
 */
export type LedgerItemState = 'IMPORTED' | 'PRESENT' | 'FAILED';

/**
 * Overall status of a Sync_Run report (Requirement 5.5).
 * Exactly one value is assigned per report.
 */
export type OverallStatus =
  | 'succeeded fully'
  | 'succeeded with skipped or failed items'
  | 'failed';

// ---------------------------------------------------------------------------
// Manifest data model (Requirement 1)
// ---------------------------------------------------------------------------

/**
 * A single package coordinate entry inside a TrackedProject.
 * Combines the ecosystem-qualified identifier and the ecosystem it belongs to.
 */
export interface PackageCoordinate {
  /** Ecosystem-qualified package identifier (e.g. npm package name, PyPI dist name). */
  coordinates: string;
  /** Package ecosystem for this coordinate. */
  ecosystem: Ecosystem;
}

/**
 * A tracked open source project: a git repository plus zero or more packages.
 * Constraints:
 *   - id must be 1..128 characters and unique within the Manifest.
 *   - gitLocation must be non-empty.
 *   - packages must contain 0..1000 entries.
 */
export interface TrackedProject {
  /** Unique identifier for this project, 1–128 characters. */
  id: string;
  /** Source git repository location (URL or local path). */
  gitLocation: string;
  /** Package coordinates to track; 0–1000 entries. */
  packages: PackageCoordinate[];
}

/**
 * The top-level configuration artifact listing all tracked projects.
 * Constraints: 1..1000 TrackedProject entries.
 */
export interface Manifest {
  /** List of tracked projects; must contain 1–1000 entries. */
  projects: TrackedProject[];
  /** Validation outcome set after loading. */
  status: ManifestStatus;
}

// ---------------------------------------------------------------------------
// Package data model
// ---------------------------------------------------------------------------

/**
 * An identified, retrievable specific version of a package.
 * Used as a key throughout the pipeline.
 */
export interface PackageRef {
  /** Ecosystem-qualified package identifier. */
  coordinates: string;
  /** Specific version string. */
  version: string;
  /** Package ecosystem. */
  ecosystem: Ecosystem;
}

/**
 * A retrieved package version: its identifying ref and the raw file bytes.
 */
export interface PackageArtifact {
  /** Identifying coordinates + version + ecosystem. */
  ref: PackageRef;
  /** Raw bytes of the package file (e.g. .tgz for npm, wheel/sdist for Python). */
  fileBytes: Buffer;
}

// ---------------------------------------------------------------------------
// Git bundle data model
// ---------------------------------------------------------------------------

/**
 * A git bundle artifact for a single tracked project.
 * Contains the raw bundle bytes plus commit-reference metadata.
 */
export interface GitBundleArtifact {
  /** Identifier of the project this bundle belongs to. */
  projectId: string;
  /** Raw bytes of the git bundle file. */
  bundleFile: Buffer;
  /**
   * The source commit SHA that acts as the exclusion boundary for incremental
   * bundles (V2 only). Absent for full-history (V1) bundles.
   */
  sourceCommit?: string;
  /**
   * Map from ref name (e.g. "refs/heads/main") to the target commit SHA.
   * These are the refs the Importer will set after a successful bundle apply.
   */
  targetCommits: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Transfer Bundle and Bundle Descriptor (Requirement 2)
// ---------------------------------------------------------------------------

/**
 * Per-project synchronization checkpoint recorded inside a BundleDescriptor.
 * Captures which git commits and package versions were packed for the project.
 */
export interface ProjectCheckpoint {
  /** Identifier of the tracked project. */
  projectId: string;
  /**
   * Source commit SHA used as the incremental boundary (V2 only).
   * Absent for full-history (V1) checkpoints.
   */
  gitSourceCommit?: string;
  /**
   * Map from ref name to the target commit SHA packed for this project.
   * Matches the targetCommits in the corresponding GitBundleArtifact.
   */
  gitTargetCommits: Record<string, string>;
  /** All package versions included in the bundle for this project. */
  packedVersions: PackageRef[];
  /** Package versions that could not be retrieved, recorded per Requirement 8.6/8.7. */
  retrievalFailures: RetrievalFailure[];
}

/**
 * Records a package version that could not be retrieved from the source.
 */
export interface RetrievalFailure {
  /** The package ref that failed to be retrieved. */
  ref: PackageRef;
  /** Human-readable reason for the retrieval failure. */
  reason: string;
}

/**
 * Metadata header of a Transfer_Bundle, describing its contents, checkpoints,
 * and integrity information (Requirement 2.2, 2.3).
 */
export interface BundleDescriptor {
  /**
   * Unique identifier for this bundle, unique across all bundles produced
   * by a single Packer instance (Requirement 2.2).
   */
  bundleId: string;
  /** Pipeline delivery version that produced this bundle. */
  deliveryVersion: DeliveryVersion;
  /** Identifies the Sync_Run that produced this bundle. */
  syncRunId: string;
  /** Per-project packing checkpoints. */
  projectCheckpoints: ProjectCheckpoint[];
  /**
   * The integrity value computed over all bundle contents, excluding this
   * field itself (Requirement 2.3).
   */
  integrityValue: string;
  /** Algorithm used to compute integrityValue. Always "SHA-256". */
  integrityAlgorithm: IntegrityAlgorithm;
}

/**
 * The complete, self-contained Transfer_Bundle produced by the Packer and
 * consumed by the Importer (Requirement 2.1).
 */
export interface TransferBundle {
  /** Git bundles, one per tracked project that had changes to pack. */
  gitBundles: GitBundleArtifact[];
  /** Package version artifacts included in this bundle. */
  packages: PackageArtifact[];
  /** Descriptor with checkpoints and integrity information. */
  descriptor: BundleDescriptor;
}

// ---------------------------------------------------------------------------
// Import Ledger (Requirement 6)
// ---------------------------------------------------------------------------

/**
 * Destination-side per-item ledger that tracks what has already been imported
 * from a given bundle, enabling idempotent and resumable imports (Requirement 6).
 */
export interface ImportLedger {
  /** The bundle whose items are tracked by this ledger. */
  bundleId: string;
  /**
   * Map from item identifier to import state.
   * Item identifiers are opaque strings (e.g. projectId for git bundles,
   * "<ecosystem>:<coordinates>@<version>" for packages).
   */
  items: Record<string, LedgerItemState>;
}

// ---------------------------------------------------------------------------
// Sync State (V2 only — Requirement 9)
// ---------------------------------------------------------------------------

/**
 * The last successfully packed baseline for a single tracked project (V2).
 */
export interface ProjectBaseline {
  /** The last git commit SHA that was successfully packed for this project. */
  lastPackedCommit: string;
  /** The set of package versions that were successfully packed. */
  packedVersions: Set<PackageRef>;
}

/**
 * Persisted source-side state that enables incremental packing (V2 only).
 * Maps project identifier to its baseline snapshot from the last successful run.
 */
export interface SyncState {
  /** Map from project id to its packing baseline. */
  projects: Record<string, ProjectBaseline>;
}

// ---------------------------------------------------------------------------
// Reporting (Requirement 5)
// ---------------------------------------------------------------------------

/**
 * A single item failure entry, carried into every report of the Sync_Run
 * (Requirement 5.4).
 */
export interface ItemFailure {
  /** Identifier of the item that failed (project id, package coordinate, etc.). */
  itemId: string;
  /** Human-readable reason for the failure. */
  reason: string;
}

/**
 * Per-project section of a SyncReport / PackReport.
 * Describes what was packed or imported for one tracked project.
 */
export interface ProjectReport {
  /** Identifier of the tracked project. */
  projectId: string;
  /**
   * Target commit references that were packed/imported, keyed by ref name.
   * Absent or empty when no git changes were packed (V2 no-op runs).
   */
  gitTargetCommits?: Record<string, string>;
  /**
   * When true the project had no new git commits to pack (V2 explicit indication,
   * Requirement 5.3).
   */
  noGitChangesPacked?: boolean;
  /** Package versions packed/imported for this project (with their ecosystems). */
  packedVersions: PackageRef[];
  /**
   * When true the project had no new package versions to pack (V2 explicit
   * indication, Requirement 5.3).
   */
  noPackageVersionsPacked?: boolean;
  /** Package versions that were already present on the destination and skipped. */
  skippedVersions?: PackageRef[];
}

/**
 * Top-level synchronization run report (shared structure for both Pack and Import
 * sides, Requirement 5.1, 5.2).
 */
export interface SyncReport {
  /** Identifier of the Sync_Run this report covers. */
  syncRunId: string;
  /** Pipeline delivery version active during this run. */
  deliveryVersion: DeliveryVersion;
  /** Per-project detail entries. */
  perProject: ProjectReport[];
  /** Single overall status classification (Requirement 5.5). */
  overallStatus: OverallStatus;
  /** All item failures recorded during this run (Requirement 5.4). */
  failures: ItemFailure[];
}

/**
 * Pack-side report produced at the end of a packing operation (Requirement 5.1).
 * Extends SyncReport with packer-specific context.
 */
export interface PackReport extends SyncReport {
  /** The bundle identifier assigned to the Transfer_Bundle produced in this run. */
  bundleId: string;
}

/**
 * Import-side report produced at the end of an import operation (Requirement 5.2).
 * Extends SyncReport with importer-specific context.
 */
export interface ImportReport extends SyncReport {
  /** Repositories that were created on the Destination_GitLab during this import. */
  createdRepositories: string[];
  /** Package versions successfully uploaded during this import. */
  uploadedVersions: PackageRef[];
  /** Repositories whose git bundles were skipped (already present). */
  skippedRepositories: string[];
}

// ---------------------------------------------------------------------------
// Manifest load result and validation errors (Requirement 1)
// ---------------------------------------------------------------------------

/**
 * A single validation error returned when Manifest loading fails.
 */
export interface ValidationError {
  /** Short machine-readable error code (e.g. "DUPLICATE_ID", "MISSING_FIELD"). */
  code: string;
  /** Human-readable description of the error. */
  message: string;
  /**
   * Project identifier affected by this error, if applicable.
   * Not present for parse-level or manifest-level errors.
   */
  projectId?: string;
  /** Name of the missing field, for MISSING_FIELD errors. */
  fieldName?: string;
  /** The duplicated identifier, for DUPLICATE_ID errors. */
  duplicatedId?: string;
  /** The unsupported ecosystem value, for UNSUPPORTED_ECOSYSTEM errors. */
  unsupportedEcosystem?: string;
  /** Package coordinates affected by an UNSUPPORTED_ECOSYSTEM error. */
  coordinates?: string;
  /** Source line of a parse failure (1-indexed). */
  line?: number;
  /** Source column of a parse failure (1-indexed). */
  column?: number;
}

/**
 * Result returned by ManifestValidator.load (Requirement 1.5, 1.10).
 * When status is VALID the manifest field is populated.
 * When status is INVALID the errors array contains one or more entries.
 */
export interface ManifestLoadResult {
  /** Outcome of the load operation. */
  status: ManifestStatus;
  /** The validated Manifest; present only when status is VALID. */
  manifest?: Manifest;
  /** Collected validation errors; non-empty only when status is INVALID. */
  errors: ValidationError[];
}
