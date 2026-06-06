/**
 * Shared components used by both the Packer and the Importer.
 *
 * Sub-modules:
 *   - ManifestValidator (Requirement 1)
 *   - EcosystemAdapter  (interface, TargetRepositoryKind, UploadOutcome,
 *                        PackageFilter, ArtifactoryConfig)
 *   - IntegrityService  (SHA-256, Node crypto)  — task 3.1
 *   - BundleWriter      (serialize + integrity)  — task 3.2
 *   - ReportBuilder                              — populated in task 8.1
 */

export { ManifestValidator } from './manifest-validator.js';

export type {
    ArtifactoryConfig,
    EcosystemAdapter, PackageFilter, TargetRepositoryKind,
    UploadOutcome
} from './ecosystem-adapter.js';

export { IntegrityService } from './integrity-service.js';
export type { BundleContents } from './integrity-service.js';

export { BundleWriter, _resetBundleCounter } from './bundle-writer.js';
export type { BundleFileFormat, WriteInput } from './bundle-writer.js';

export { BundleReader } from './bundle-reader.js';
export type { BundleLoadResult, LoadedBundle, RejectReason } from './bundle-reader.js';

export { DependencyResolver } from './dependency-resolver.js';
export type { ResolveResult } from './dependency-resolver.js';
export { REPORT_GENERATION_FAILED, ReportBuilder } from './report-builder.js';
export type { ImportReportInput, PackReportInput } from './report-builder.js';

