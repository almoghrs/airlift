/**
 * ReportBuilder — builds Pack and Import reports for a Sync_Run.
 *
 * Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 3.7
 */

import type {
    DeliveryVersion,
    ImportReport,
    ItemFailure,
    OverallStatus,
    PackReport,
    PackageRef,
    ProjectReport,
} from '../types/index.js';

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface PackReportInput {
  syncRunId: string;
  deliveryVersion: DeliveryVersion;
  bundleId: string;
  perProject: ProjectReport[];
  failures: ItemFailure[];
}

export interface ImportReportInput {
  syncRunId: string;
  deliveryVersion: DeliveryVersion;
  perProject: ProjectReport[];
  failures: ItemFailure[];
  createdRepositories: string[];
  uploadedVersions: PackageRef[];
  skippedRepositories: string[];
}

// ---------------------------------------------------------------------------
// Error code used when report generation itself fails (Requirement 5.6)
// ---------------------------------------------------------------------------

export const REPORT_GENERATION_FAILED = 'REPORT_GENERATION_FAILED';

// ---------------------------------------------------------------------------
// ReportBuilder
// ---------------------------------------------------------------------------

export class ReportBuilder {
  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build a Pack Report (Requirement 5.1).
   *
   * Classifies overall status based on items and failures (Requirement 5.5).
   * Carries all failures from the run into the report (Requirement 5.4).
   * If report generation throws, returns a failed report (Requirement 5.6).
   */
  buildPackReport(input: PackReportInput): PackReport {
    try {
      const overallStatus = this._classifyStatus(
        input.failures,
        input.perProject,
      );

      return {
        syncRunId: input.syncRunId,
        deliveryVersion: input.deliveryVersion,
        bundleId: input.bundleId,
        perProject: input.perProject,
        overallStatus,
        failures: input.failures,
      };
    } catch (err) {
      return this._failedPackReport(input.syncRunId, input.deliveryVersion, input.bundleId, err);
    }
  }

  /**
   * Build an Import Report (Requirement 5.2).
   *
   * Classifies overall status based on items and failures (Requirement 5.5).
   * Carries all failures from the run into the report (Requirement 5.4).
   * If report generation throws, returns a failed report (Requirement 5.6).
   */
  buildImportReport(input: ImportReportInput): ImportReport {
    try {
      const overallStatus = this._classifyStatus(
        input.failures,
        input.perProject,
      );

      return {
        syncRunId: input.syncRunId,
        deliveryVersion: input.deliveryVersion,
        perProject: input.perProject,
        overallStatus,
        failures: input.failures,
        createdRepositories: input.createdRepositories,
        uploadedVersions: input.uploadedVersions,
        skippedRepositories: input.skippedRepositories,
      };
    } catch (err) {
      return this._failedImportReport(input.syncRunId, input.deliveryVersion, err);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Determine the overall status for a completed operation (Requirement 5.5):
   *   - 'succeeded fully'                       — no failures, no skipped versions
   *   - 'succeeded with skipped or failed items' — at least one failure or skip
   *   - 'failed'                                 — operation could not complete
   *     (this value is set by the callers above, not by this method)
   */
  private _classifyStatus(
    failures: ItemFailure[],
    perProject: ProjectReport[],
  ): OverallStatus {
    if (failures.length > 0) {
      return 'succeeded with skipped or failed items';
    }

    const hasSkippedVersions = perProject.some(
      (p) => p.skippedVersions !== undefined && p.skippedVersions.length > 0,
    );

    if (hasSkippedVersions) {
      return 'succeeded with skipped or failed items';
    }

    return 'succeeded fully';
  }

  /**
   * Return a minimal PackReport that signals report-generation failure
   * (Requirement 5.6). Fields syncRunId, deliveryVersion, and bundleId are
   * preserved; everything else is minimal / empty.
   */
  private _failedPackReport(
    syncRunId: string,
    deliveryVersion: DeliveryVersion,
    bundleId: string,
    cause: unknown,
  ): PackReport {
    const reason =
      cause instanceof Error ? cause.message : String(cause ?? 'unknown error');

    return {
      syncRunId,
      deliveryVersion,
      bundleId,
      perProject: [],
      overallStatus: 'failed',
      failures: [
        {
          itemId: REPORT_GENERATION_FAILED,
          reason: `Report generation failed: ${reason}`,
        },
      ],
    };
  }

  /**
   * Return a minimal ImportReport that signals report-generation failure
   * (Requirement 5.6).
   */
  private _failedImportReport(
    syncRunId: string,
    deliveryVersion: DeliveryVersion,
    cause: unknown,
  ): ImportReport {
    const reason =
      cause instanceof Error ? cause.message : String(cause ?? 'unknown error');

    return {
      syncRunId,
      deliveryVersion,
      perProject: [],
      overallStatus: 'failed',
      failures: [
        {
          itemId: REPORT_GENERATION_FAILED,
          reason: `Report generation failed: ${reason}`,
        },
      ],
      createdRepositories: [],
      uploadedVersions: [],
      skippedRepositories: [],
    };
  }
}
