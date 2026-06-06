/**
 * Unit tests for ReportBuilder.
 *
 * Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 3.7
 */

import type { ItemFailure, PackageRef, ProjectReport } from '../types/index';
import type { ImportReportInput, PackReportInput } from './report-builder';
import { REPORT_GENERATION_FAILED, ReportBuilder } from './report-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePackInput(overrides: Partial<PackReportInput> = {}): PackReportInput {
  return {
    syncRunId: 'run-001',
    deliveryVersion: 'V1',
    bundleId: 'bundle-abc',
    perProject: [],
    failures: [],
    ...overrides,
  };
}

function makeImportInput(overrides: Partial<ImportReportInput> = {}): ImportReportInput {
  return {
    syncRunId: 'run-001',
    deliveryVersion: 'V1',
    perProject: [],
    failures: [],
    createdRepositories: [],
    uploadedVersions: [],
    skippedRepositories: [],
    ...overrides,
  };
}

const sampleRef: PackageRef = {
  coordinates: 'lodash',
  version: '4.17.21',
  ecosystem: 'npm',
};

const sampleFailure: ItemFailure = {
  itemId: 'project-x',
  reason: 'git bundle failed',
};

const sampleProject: ProjectReport = {
  projectId: 'my-project',
  packedVersions: [sampleRef],
};

// ---------------------------------------------------------------------------
// ReportBuilder — Pack reports
// ---------------------------------------------------------------------------

describe('ReportBuilder.buildPackReport', () => {
  const builder = new ReportBuilder();

  it('returns succeeded fully when no failures and no skipped versions', () => {
    const report = builder.buildPackReport(makePackInput({
      perProject: [{ projectId: 'p1', packedVersions: [] }],
    }));

    expect(report.overallStatus).toBe('succeeded fully');
    expect(report.failures).toHaveLength(0);
  });

  it('returns succeeded with skipped or failed items when there is a failure', () => {
    const report = builder.buildPackReport(makePackInput({
      failures: [sampleFailure],
    }));

    expect(report.overallStatus).toBe('succeeded with skipped or failed items');
  });

  it('returns succeeded with skipped or failed items when a project has skipped versions', () => {
    const projectWithSkips: ProjectReport = {
      projectId: 'p1',
      packedVersions: [],
      skippedVersions: [sampleRef],
    };
    const report = builder.buildPackReport(makePackInput({
      perProject: [projectWithSkips],
    }));

    expect(report.overallStatus).toBe('succeeded with skipped or failed items');
  });

  it('propagates failures verbatim into the report', () => {
    const failures: ItemFailure[] = [
      { itemId: 'proj-a', reason: 'git error' },
      { itemId: 'npm:lodash@1.0', reason: 'retrieval failed' },
    ];
    const report = builder.buildPackReport(makePackInput({ failures }));

    expect(report.failures).toEqual(failures);
  });

  it('includes syncRunId, deliveryVersion, and bundleId', () => {
    const report = builder.buildPackReport(makePackInput({
      syncRunId: 'run-xyz',
      deliveryVersion: 'V2',
      bundleId: 'bnd-999',
    }));

    expect(report.syncRunId).toBe('run-xyz');
    expect(report.deliveryVersion).toBe('V2');
    expect(report.bundleId).toBe('bnd-999');
  });

  it('preserves all perProject data', () => {
    const projects: ProjectReport[] = [
      { projectId: 'p1', packedVersions: [sampleRef] },
      { projectId: 'p2', packedVersions: [], gitTargetCommits: { 'refs/heads/main': 'abc123' } },
    ];
    const report = builder.buildPackReport(makePackInput({ perProject: projects }));

    expect(report.perProject).toEqual(projects);
  });

  it('marks run as failed and records REPORT_GENERATION_FAILED on internal error', () => {
    // Construct an input that will throw during status classification by
    // making perProject a getter that throws.
    const badInput = makePackInput();
    Object.defineProperty(badInput, 'perProject', {
      get() {
        throw new Error('internal boom');
      },
    });

    const report = builder.buildPackReport(badInput);

    expect(report.overallStatus).toBe('failed');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.itemId).toBe(REPORT_GENERATION_FAILED);
    expect(report.failures[0]!.reason).toContain('internal boom');
    // syncRunId and deliveryVersion and bundleId are still valid
    expect(report.syncRunId).toBe('run-001');
    expect(report.deliveryVersion).toBe('V1');
    expect(report.bundleId).toBe('bundle-abc');
  });
});

// ---------------------------------------------------------------------------
// ReportBuilder — Import reports
// ---------------------------------------------------------------------------

describe('ReportBuilder.buildImportReport', () => {
  const builder = new ReportBuilder();

  it('returns succeeded fully when no failures and no skipped versions', () => {
    const report = builder.buildImportReport(makeImportInput({
      perProject: [{ projectId: 'p1', packedVersions: [] }],
    }));

    expect(report.overallStatus).toBe('succeeded fully');
    expect(report.failures).toHaveLength(0);
  });

  it('returns succeeded with skipped or failed items when there is a failure', () => {
    const report = builder.buildImportReport(makeImportInput({
      failures: [sampleFailure],
    }));

    expect(report.overallStatus).toBe('succeeded with skipped or failed items');
  });

  it('returns succeeded with skipped or failed items when a project has skipped versions', () => {
    const projectWithSkips: ProjectReport = {
      projectId: 'p1',
      packedVersions: [],
      skippedVersions: [sampleRef],
    };
    const report = builder.buildImportReport(makeImportInput({
      perProject: [projectWithSkips],
    }));

    expect(report.overallStatus).toBe('succeeded with skipped or failed items');
  });

  it('propagates failures verbatim into the report', () => {
    const failures: ItemFailure[] = [
      { itemId: 'proj-a', reason: 'upload error' },
    ];
    const report = builder.buildImportReport(makeImportInput({ failures }));

    expect(report.failures).toEqual(failures);
  });

  it('includes syncRunId and deliveryVersion', () => {
    const report = builder.buildImportReport(makeImportInput({
      syncRunId: 'run-import-1',
      deliveryVersion: 'V2',
    }));

    expect(report.syncRunId).toBe('run-import-1');
    expect(report.deliveryVersion).toBe('V2');
  });

  it('preserves createdRepositories, uploadedVersions, and skippedRepositories', () => {
    const report = builder.buildImportReport(makeImportInput({
      createdRepositories: ['repo-a', 'repo-b'],
      uploadedVersions: [sampleRef],
      skippedRepositories: ['repo-c'],
    }));

    expect(report.createdRepositories).toEqual(['repo-a', 'repo-b']);
    expect(report.uploadedVersions).toEqual([sampleRef]);
    expect(report.skippedRepositories).toEqual(['repo-c']);
  });

  it('preserves all perProject data', () => {
    const report = builder.buildImportReport(makeImportInput({
      perProject: [sampleProject],
    }));

    expect(report.perProject).toEqual([sampleProject]);
  });

  it('marks run as failed and records REPORT_GENERATION_FAILED on internal error', () => {
    const badInput = makeImportInput();
    Object.defineProperty(badInput, 'perProject', {
      get() {
        throw new Error('boom during import report');
      },
    });

    const report = builder.buildImportReport(badInput);

    expect(report.overallStatus).toBe('failed');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.itemId).toBe(REPORT_GENERATION_FAILED);
    expect(report.failures[0]!.reason).toContain('boom during import report');
    expect(report.syncRunId).toBe('run-001');
    expect(report.deliveryVersion).toBe('V1');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('ReportBuilder — edge cases', () => {
  const builder = new ReportBuilder();

  it('skippedVersions: empty array does NOT trigger skipped status', () => {
    const report = builder.buildPackReport(makePackInput({
      perProject: [{ projectId: 'p1', packedVersions: [], skippedVersions: [] }],
    }));
    expect(report.overallStatus).toBe('succeeded fully');
  });

  it('failures AND skipped versions both present → succeeded with skipped or failed items', () => {
    const report = builder.buildPackReport(makePackInput({
      failures: [sampleFailure],
      perProject: [{ projectId: 'p1', packedVersions: [], skippedVersions: [sampleRef] }],
    }));
    expect(report.overallStatus).toBe('succeeded with skipped or failed items');
  });

  it('handles empty perProject with no failures', () => {
    const report = builder.buildPackReport(makePackInput({ perProject: [], failures: [] }));
    expect(report.overallStatus).toBe('succeeded fully');
    expect(report.perProject).toHaveLength(0);
  });
});
