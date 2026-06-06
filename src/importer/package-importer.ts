/**
 * PackageImporter — uploads Package_Version artifacts to Destination_Artifactory.
 *
 * Routing: each package is sent to the ecosystem-matching repository via the
 * corresponding EcosystemAdapter (npm → npm repo, Python → pypi repo).
 *
 * Idempotency: consults the ImportLedger before uploading; if the item is
 * already recorded as IMPORTED or PRESENT it is skipped immediately without
 * calling the adapter.
 *
 * Retry / timeout: each upload attempt is capped at `timeoutMs` (default 300 s).
 * On failure or timeout the attempt is retried up to `maxRetries` times (default 3).
 * After all retries are exhausted the package is recorded as FAILED and processing
 * continues with the next package.
 *
 * Ledger-write failure (Requirement 4.5): if the ledger record call throws after a
 * successful upload the importer halts immediately, surfaces a `haltedByLedgerFailure`
 * entry, and returns — preserving every item already recorded.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type { EcosystemAdapter } from '../shared/ecosystem-adapter.js';
import type { Ecosystem, ItemFailure, PackageArtifact, PackageRef } from '../types/index.js';
import type { ImportLedgerService } from './import-ledger.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface PackageImportResult {
  /** Package versions successfully uploaded during this run. */
  uploaded: PackageRef[];
  /** Package versions that were already present (in ledger or on Artifactory). */
  skipped: PackageRef[];
  /** Package versions that failed to upload after all retries. */
  failures: ItemFailure[];
  /**
   * Present when a ledger-write failure halted processing (Requirement 4.5).
   * Contains the package that triggered the halt and the failure reason.
   * When set, `uploaded` / `skipped` / `failures` contain only items processed
   * before the halt.
   */
  haltedByLedgerFailure?: { ref: PackageRef; reason: string };
}

// ---------------------------------------------------------------------------
// PackageImporter
// ---------------------------------------------------------------------------

export class PackageImporter {
  constructor(
    private readonly adapters: Map<Ecosystem, EcosystemAdapter>,
    /** Per-attempt upload timeout in milliseconds (Requirement 4.1). */
    private readonly timeoutMs: number = 300_000,
    /** Maximum upload attempts per package (Requirement 4.6). */
    private readonly maxRetries: number = 3,
  ) {}

  /**
   * Import a list of package artifacts into Destination_Artifactory,
   * using the provided ledger for idempotency.
   */
  async importPackages(
    packages: PackageArtifact[],
    ledger: ImportLedgerService,
  ): Promise<PackageImportResult> {
    const result: PackageImportResult = {
      uploaded: [],
      skipped: [],
      failures: [],
    };

    for (const pkg of packages) {
      const { ref, fileBytes } = pkg;
      const itemId = `${ref.ecosystem}:${ref.coordinates}@${ref.version}`;

      // -----------------------------------------------------------------------
      // 1. Check ledger — skip if already completed (IMPORTED or PRESENT).
      // -----------------------------------------------------------------------
      if (ledger.isCompleted(itemId)) {
        result.skipped.push(ref);
        // Ledger already has the PRESENT/IMPORTED state; no need to re-record.
        continue;
      }

      // -----------------------------------------------------------------------
      // 2. Resolve the ecosystem adapter (Requirement 4.2).
      // -----------------------------------------------------------------------
      const adapter = this.adapters.get(ref.ecosystem);
      if (!adapter) {
        // No adapter available — treat as a permanent upload failure.
        const reason = `No adapter registered for ecosystem "${ref.ecosystem}"`;
        ledger.record(itemId, 'FAILED');
        result.failures.push({ itemId, reason });
        continue;
      }

      // -----------------------------------------------------------------------
      // 3. Attempt upload with retries and per-attempt timeout.
      // -----------------------------------------------------------------------
      let uploaded = false;
      let lastFailureReason = 'Unknown failure';

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        let outcome: import('../shared/ecosystem-adapter.js').UploadOutcome;

        try {
          outcome = await Promise.race([
            adapter.upload(ref, fileBytes),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`Upload timeout after ${this.timeoutMs}ms`)),
                this.timeoutMs,
              ),
            ),
          ]);
        } catch (err: unknown) {
          // Timeout or unexpected rejection — count as a failed attempt.
          lastFailureReason =
            err instanceof Error ? err.message : String(err);
          // Retry unless we've exhausted attempts.
          continue;
        }

        if (outcome.kind === 'already_present') {
          // Package is already on Destination_Artifactory — record and skip.
          ledger.record(itemId, 'PRESENT');
          result.skipped.push(ref);
          uploaded = true; // sentinel: we resolved this package (no further retries)
          break;
        }

        if (outcome.kind === 'uploaded') {
          // Successful upload — record in ledger (Requirement 4.4).
          try {
            ledger.record(itemId, 'IMPORTED');
          } catch (recordErr: unknown) {
            // Ledger-write failure after successful upload → halt (Requirement 4.5).
            const reason =
              recordErr instanceof Error ? recordErr.message : String(recordErr);
            result.haltedByLedgerFailure = { ref, reason };
            return result;
          }

          result.uploaded.push(ref);
          uploaded = true;
          break;
        }

        if (outcome.kind === 'failed') {
          lastFailureReason = outcome.reason;
          // Will retry on next iteration (if attempts remain).
        }
      }

      // -----------------------------------------------------------------------
      // 4. After retries: if still not resolved, record as FAILED and continue.
      // -----------------------------------------------------------------------
      if (!uploaded) {
        // Record failure in ledger and add to failures list (Requirement 4.6).
        ledger.record(itemId, 'FAILED');
        result.failures.push({ itemId, reason: lastFailureReason });
        // Leave previously imported packages unchanged; continue with next.
      }
    }

    return result;
  }
}
