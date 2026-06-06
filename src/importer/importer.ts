/**
 * Importer — destination-side orchestrator.
 *
 * Loads a Transfer_Bundle, verifies integrity, then processes all Git_Bundles
 * and Package_Versions through the ledger and importers, and emits an Import
 * Report with the overall status.
 *
 * Rejection policy (Requirements 2.4, 2.5, 2.6):
 *   - Any BundleReader rejection → `overallStatus: 'failed'`, zero writes.
 *
 * Git skipped/failed items (Requirement 3.7):
 *   - When any git bundle was skipped or failed the report's overall status is
 *     forced to at least 'succeeded with skipped or failed items'.
 *
 * Requirements: 2.4, 2.5, 2.6, 3.7, 5.2, 6.1, 6.4
 */

import { BundleReader } from '../shared/bundle-reader';
import type { EcosystemAdapter } from '../shared/ecosystem-adapter';
import { IntegrityService } from '../shared/integrity-service';
import { ReportBuilder } from '../shared/report-builder';
import type {
    DeliveryVersion,
    Ecosystem,
    ImportReport,
    ItemFailure,
    ProjectReport,
} from '../types/index';
import type { GitLabConfig } from './git-importer';
import { GitImporter } from './git-importer';
import { ImportLedgerService } from './import-ledger';
import { PackageImporter } from './package-importer';

// ---------------------------------------------------------------------------
// Public configuration type
// ---------------------------------------------------------------------------

export interface ImporterConfig {
  /** Path to the Transfer_Bundle file on disk. */
  bundlePath: string;
  /** Optional path to persist the ledger to disk for resumability (not yet wired). */
  ledgerPath?: string;
  /** GitLab destination configuration. */
  gitConfig: GitLabConfig;
  /** Ecosystem adapters keyed by ecosystem name. */
  adapters: Map<Ecosystem, EcosystemAdapter>;
  /** Sync run identifier to embed in the report. */
  syncRunId: string;
  /** Delivery version to embed in the report. */
  deliveryVersion: DeliveryVersion;
}

// ---------------------------------------------------------------------------
// Importer orchestrator
// ---------------------------------------------------------------------------

export class Importer {
  /**
   * Run a full import cycle:
   *   1. Load + verify the bundle (abort with zero writes on any rejection)
   *   2. Process each Git_Bundle through the ledger + GitImporter
   *   3. Process each Package_Version through the ledger + PackageImporter
   *   4. Build and return the Import Report
   */
  async run(config: ImporterConfig): Promise<ImportReport> {
    const reportBuilder = new ReportBuilder();

    // -----------------------------------------------------------------------
    // 1. Load and verify the bundle (Requirements 2.4, 2.5, 2.6)
    //    Zero writes are guaranteed because we do not create importers until
    //    a valid bundle is in hand.
    // -----------------------------------------------------------------------
    const integrityService = new IntegrityService();
    const bundleReader = new BundleReader(integrityService);

    const loadResult = await bundleReader.read(config.bundlePath);

    if ('reject' in loadResult) {
      const { reject } = loadResult;

      let failureMessage: string;
      switch (reject.kind) {
        case 'descriptor_absent':
          failureMessage = 'Bundle rejected: descriptor is absent or unreadable';
          break;
        case 'descriptor_unparseable':
          failureMessage = `Bundle rejected: descriptor cannot be parsed — ${reject.details}`;
          break;
        case 'integrity_value_missing':
          failureMessage = 'Bundle rejected: integrity value is missing from descriptor';
          break;
        case 'integrity_mismatch':
          failureMessage = `Bundle rejected: integrity mismatch for bundle "${reject.bundleId}"`;
          break;
        default: {
          // exhaustive check — reject satisfies never
          void (reject as never);
          failureMessage = `Bundle rejected: unknown reason`;
        }
      }

      // Bundle-level rejection is always 'failed' (Requirements 2.5, 2.6):
      // the operation could not complete, not merely "some items were skipped".
      const rejectedReport = reportBuilder.buildImportReport({
        syncRunId: config.syncRunId,
        deliveryVersion: config.deliveryVersion,
        perProject: [],
        failures: [{ itemId: 'bundle', reason: failureMessage }],
        createdRepositories: [],
        uploadedVersions: [],
        skippedRepositories: [],
      });
      return { ...rejectedReport, overallStatus: 'failed' };
    }

    // Bundle is valid — safe to proceed with destination writes.
    const { bundle } = loadResult;
    const { descriptor, gitBundles, packages } = bundle;

    // -----------------------------------------------------------------------
    // 2. Create the ledger (keyed to this bundle id, Requirement 6.4)
    // -----------------------------------------------------------------------
    const ledger = new ImportLedgerService(descriptor.bundleId);

    // -----------------------------------------------------------------------
    // 3. Import git bundles (Requirements 3.1–3.6, 6.2)
    // -----------------------------------------------------------------------
    const gitImporter = new GitImporter(config.gitConfig);
    const gitResult = await gitImporter.importBundles(gitBundles, descriptor, ledger);

    // -----------------------------------------------------------------------
    // 4. Import package versions (Requirements 4.1–4.6, 6.4)
    // -----------------------------------------------------------------------
    const packageImporter = new PackageImporter(config.adapters);
    const pkgResult = await packageImporter.importPackages(packages, ledger);

    // -----------------------------------------------------------------------
    // 5. Collect failures from both import passes
    // -----------------------------------------------------------------------
    const allFailures: ItemFailure[] = [
      ...gitResult.failed,
      ...pkgResult.failures,
      ...(pkgResult.haltedByLedgerFailure
        ? [{
            itemId: pkgResult.haltedByLedgerFailure.ref.coordinates,
            reason: pkgResult.haltedByLedgerFailure.reason,
          }]
        : []),
    ];

    // -----------------------------------------------------------------------
    // 6. Build per-project ProjectReport[] from the descriptor checkpoints
    // -----------------------------------------------------------------------
    const perProject: ProjectReport[] = descriptor.projectCheckpoints.map((cp) => ({
      projectId: cp.projectId,
      gitTargetCommits: cp.gitTargetCommits,
      packedVersions: cp.packedVersions,
      skippedVersions: pkgResult.skipped.filter(
        (ref) =>
          cp.packedVersions.some(
            (pv) =>
              pv.coordinates === ref.coordinates &&
              pv.version === ref.version &&
              pv.ecosystem === ref.ecosystem,
          ),
      ),
    }));

    // -----------------------------------------------------------------------
    // 7. Build and return the Import Report (Requirements 5.2, 3.7)
    //    If any git bundle was skipped or failed we must force the overall
    //    status to at least 'succeeded with skipped or failed items'.
    // -----------------------------------------------------------------------
    const hasGitSkipsOrFailures =
      gitResult.skipped.length > 0 || gitResult.failed.length > 0;

    // Build the report using ReportBuilder first
    const report = reportBuilder.buildImportReport({
      syncRunId: config.syncRunId,
      deliveryVersion: config.deliveryVersion,
      perProject,
      failures: allFailures,
      createdRepositories: gitResult.imported,
      uploadedVersions: pkgResult.uploaded,
      skippedRepositories: gitResult.skipped,
    });

    // Apply the Requirement 3.7 override: if any git bundle was skipped/failed
    // and the report doesn't already reflect a non-'succeeded fully' status,
    // upgrade it.
    if (hasGitSkipsOrFailures && report.overallStatus === 'succeeded fully') {
      return {
        ...report,
        overallStatus: 'succeeded with skipped or failed items',
      };
    }

    return report;
  }
}
