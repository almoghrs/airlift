/**
 * Importer — destination-side component.
 * Loads a Transfer_Bundle carried across the air gap, verifies its integrity,
 * then publishes git history to Destination_GitLab and uploads package versions
 * to Destination_Artifactory, idempotently and resumably.
 *
 * Sub-modules:
 *   - BundleReader + IntegrityService  (shared)
 *   - GitImporter
 *   - PackageImporter
 *   - ImportLedger
 *   - ReportBuilder
 */

export { GitImporter } from './git-importer.js';
export type { GitImportResult, GitLabConfig } from './git-importer.js';
export { ImportLedgerService } from './import-ledger.js';
export { Importer } from './importer.js';
export type { ImporterConfig } from './importer.js';
export { PackageImporter } from './package-importer.js';
export type { PackageImportResult } from './package-importer.js';

