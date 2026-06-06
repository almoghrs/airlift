/**
 * Unit tests for PackageImporter.
 *
 * Covers:
 *   - Already present in ledger → skipped, no upload call
 *   - Upload returns already_present → skipped, recorded as PRESENT
 *   - Upload succeeds → recorded as IMPORTED, added to uploaded
 *   - Upload fails 3 times → added to failures, next package still processed
 *   - Upload timeout → retry; after max retries → failure
 *   - Ledger-write failure after successful upload → haltedByLedgerFailure, remaining packages not processed
 *   - Multi-package: mix of success, skip, failure
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */

import type { EcosystemAdapter, UploadOutcome } from '../shared/ecosystem-adapter';
import type { Ecosystem, PackageArtifact, PackageRef } from '../types/index';
import { ImportLedgerService } from './import-ledger';
import { PackageImporter } from './package-importer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRef(
  coordinates: string,
  version: string,
  ecosystem: Ecosystem = 'npm',
): PackageRef {
  return { coordinates, version, ecosystem };
}

function makeArtifact(ref: PackageRef, bytes: Buffer = Buffer.from('data')): PackageArtifact {
  return { ref, fileBytes: bytes };
}

function itemId(ref: PackageRef): string {
  return `${ref.ecosystem}:${ref.coordinates}@${ref.version}`;
}

/** Build a minimal EcosystemAdapter mock with a controllable upload sequence. */
function makeAdapter(
  ecosystem: Ecosystem,
  uploadOutcomes: UploadOutcome[],
): EcosystemAdapter {
  let callIndex = 0;
  return {
    ecosystem,
    targetRepositoryKind: ecosystem === 'npm' ? 'npm' : 'pypi',
    discoverVersions: jest.fn(),
    parseDependencies: jest.fn(),
    download: jest.fn(),
    upload: jest.fn(async () => {
      const outcome = uploadOutcomes[callIndex] ?? { kind: 'failed', reason: 'no more outcomes' };
      callIndex++;
      return outcome;
    }),
  } as unknown as EcosystemAdapter;
}

/** Build adapters map with a single npm adapter. */
function npmAdapters(outcomes: UploadOutcome[]): Map<Ecosystem, EcosystemAdapter> {
  return new Map([['npm', makeAdapter('npm', outcomes)]]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PackageImporter', () => {
  // -------------------------------------------------------------------------
  // Already present in ledger
  // -------------------------------------------------------------------------
  describe('when a package is already completed in the ledger', () => {
    it('skips the package without calling upload', async () => {
      const ref = makeRef('lodash', '4.17.21');
      const ledger = new ImportLedgerService('bundle-1');
      ledger.record(itemId(ref), 'IMPORTED');

      const adapter = makeAdapter('npm', []);
      const importer = new PackageImporter(new Map([['npm', adapter]]));

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.skipped).toEqual([ref]);
      expect(result.uploaded).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(adapter.upload).not.toHaveBeenCalled();
    });

    it('skips when ledger state is PRESENT', async () => {
      const ref = makeRef('react', '18.0.0');
      const ledger = new ImportLedgerService('bundle-1');
      ledger.record(itemId(ref), 'PRESENT');

      const importer = new PackageImporter(new Map());

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.skipped).toEqual([ref]);
      expect(result.uploaded).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Upload returns already_present
  // -------------------------------------------------------------------------
  describe('when upload returns already_present', () => {
    it('records PRESENT in ledger and adds to skipped', async () => {
      const ref = makeRef('chalk', '5.0.0');
      const ledger = new ImportLedgerService('bundle-1');

      const importer = new PackageImporter(npmAdapters([{ kind: 'already_present' }]));

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.skipped).toEqual([ref]);
      expect(result.uploaded).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(ledger.getState(itemId(ref))).toBe('PRESENT');
    });
  });

  // -------------------------------------------------------------------------
  // Successful upload
  // -------------------------------------------------------------------------
  describe('when upload succeeds', () => {
    it('records IMPORTED in ledger and adds to uploaded', async () => {
      const ref = makeRef('express', '4.18.0');
      const ledger = new ImportLedgerService('bundle-1');

      const importer = new PackageImporter(npmAdapters([{ kind: 'uploaded' }]));

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.uploaded).toEqual([ref]);
      expect(result.skipped).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(ledger.getState(itemId(ref))).toBe('IMPORTED');
    });
  });

  // -------------------------------------------------------------------------
  // Upload fails all retries
  // -------------------------------------------------------------------------
  describe('when upload fails all 3 attempts', () => {
    it('records FAILED and adds to failures, continues with remaining packages', async () => {
      const failRef = makeRef('broken-pkg', '1.0.0');
      const okRef = makeRef('ok-pkg', '2.0.0');

      const adapter = makeAdapter('npm', [
        { kind: 'failed', reason: 'network error' },
        { kind: 'failed', reason: 'network error' },
        { kind: 'failed', reason: 'network error' },
        { kind: 'uploaded' }, // for the second package
      ]);
      const ledger = new ImportLedgerService('bundle-1');
      const importer = new PackageImporter(new Map([['npm', adapter]]), 300_000, 3);

      const result = await importer.importPackages(
        [makeArtifact(failRef), makeArtifact(okRef)],
        ledger,
      );

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.itemId).toBe(itemId(failRef));
      expect(result.uploaded).toEqual([okRef]);
      expect(ledger.getState(itemId(failRef))).toBe('FAILED');
      expect(ledger.getState(itemId(okRef))).toBe('IMPORTED');
    });

    it('calls upload exactly maxRetries times', async () => {
      const ref = makeRef('flaky', '0.0.1');
      const adapter = makeAdapter('npm', [
        { kind: 'failed', reason: 'err' },
        { kind: 'failed', reason: 'err' },
        { kind: 'failed', reason: 'err' },
      ]);
      const ledger = new ImportLedgerService('bundle-1');
      const importer = new PackageImporter(new Map([['npm', adapter]]), 300_000, 3);

      await importer.importPackages([makeArtifact(ref)], ledger);

      expect(adapter.upload).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // Upload timeout
  // -------------------------------------------------------------------------
  describe('when upload times out', () => {
    it('retries and records failure after all attempts timeout', async () => {
      const ref = makeRef('slow-pkg', '1.0.0');
      const ledger = new ImportLedgerService('bundle-1');

      // Adapter that always hangs (never resolves)
      const hangingAdapter: EcosystemAdapter = {
        ecosystem: 'npm',
        targetRepositoryKind: 'npm',
        discoverVersions: jest.fn(),
        parseDependencies: jest.fn(),
        download: jest.fn(),
        upload: jest.fn(() => new Promise<UploadOutcome>(() => { /* never resolves */ })),
      } as unknown as EcosystemAdapter;

      // Use a very short timeout (5 ms) so the test runs quickly.
      const importer = new PackageImporter(new Map([['npm', hangingAdapter]]), 5, 3);

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.itemId).toBe(itemId(ref));
      expect(result.failures[0]!.reason).toMatch(/timeout/i);
      expect(ledger.getState(itemId(ref))).toBe('FAILED');
      // Retried up to maxRetries times
      expect(hangingAdapter.upload).toHaveBeenCalledTimes(3);
    }, 10_000);

    it('succeeds on retry after a timeout', async () => {
      const ref = makeRef('recovering', '1.2.3');
      const ledger = new ImportLedgerService('bundle-1');
      let callCount = 0;

      const adapter: EcosystemAdapter = {
        ecosystem: 'npm',
        targetRepositoryKind: 'npm',
        discoverVersions: jest.fn(),
        parseDependencies: jest.fn(),
        download: jest.fn(),
        upload: jest.fn((): Promise<UploadOutcome> => {
          callCount++;
          if (callCount === 1) {
            // First call: hang so it times out
            return new Promise<UploadOutcome>(() => { /* never resolves */ });
          }
          // Second call: succeed immediately
          return Promise.resolve({ kind: 'uploaded' });
        }),
      } as unknown as EcosystemAdapter;

      const importer = new PackageImporter(new Map([['npm', adapter]]), 5, 3);

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.uploaded).toEqual([ref]);
      expect(result.failures).toEqual([]);
      expect(ledger.getState(itemId(ref))).toBe('IMPORTED');
    }, 10_000);
  });

  // -------------------------------------------------------------------------
  // Ledger-write failure after successful upload (Requirement 4.5)
  // -------------------------------------------------------------------------
  describe('when ledger record throws after a successful upload', () => {
    it('halts processing, returns haltedByLedgerFailure, retains prior records', async () => {
      const successBefore = makeRef('safe-pkg', '1.0.0');
      const haltTrigger = makeRef('halt-trigger', '2.0.0');
      const afterHalt = makeRef('after-halt', '3.0.0');

      // Adapter returns uploaded for all packages
      const adapter = makeAdapter('npm', [
        { kind: 'uploaded' }, // successBefore
        { kind: 'uploaded' }, // haltTrigger
        { kind: 'uploaded' }, // afterHalt (should never be reached)
      ]);

      // Custom ledger that throws on second record call (the haltTrigger package)
      const realLedger = new ImportLedgerService('bundle-1');
      let recordCount = 0;
      const ledger = {
        isCompleted: realLedger.isCompleted.bind(realLedger),
        record: jest.fn((id: string, state: import('../types/index').LedgerItemState) => {
          recordCount++;
          if (recordCount === 2) {
            throw new Error('Disk write failure');
          }
          realLedger.record(id, state);
        }),
        getState: realLedger.getState.bind(realLedger),
        snapshot: realLedger.snapshot.bind(realLedger),
        getItemsByState: realLedger.getItemsByState.bind(realLedger),
      } as unknown as ImportLedgerService;

      const importer = new PackageImporter(new Map([['npm', adapter]]));

      const result = await importer.importPackages(
        [makeArtifact(successBefore), makeArtifact(haltTrigger), makeArtifact(afterHalt)],
        ledger,
      );

      // Should have halted
      expect(result.haltedByLedgerFailure).toBeDefined();
      expect(result.haltedByLedgerFailure!.ref).toEqual(haltTrigger);
      expect(result.haltedByLedgerFailure!.reason).toMatch(/disk write failure/i);

      // Package before the halt was successfully recorded
      expect(result.uploaded).toEqual([successBefore]);

      // Package after the halt was not processed
      expect(result.uploaded).not.toContainEqual(afterHalt);
      expect(result.failures).not.toContainEqual(
        expect.objectContaining({ itemId: itemId(afterHalt) }),
      );

      // afterHalt upload was never attempted
      expect(adapter.upload).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // No adapter registered for ecosystem
  // -------------------------------------------------------------------------
  describe('when no adapter is registered for the ecosystem', () => {
    it('records FAILED and adds to failures without calling upload', async () => {
      const ref: PackageRef = makeRef('some-python-pkg', '1.0.0', 'Python');
      const ledger = new ImportLedgerService('bundle-1');

      // Only npm adapter registered, not Python
      const importer = new PackageImporter(npmAdapters([{ kind: 'uploaded' }]));

      const result = await importer.importPackages([makeArtifact(ref)], ledger);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.itemId).toBe(itemId(ref));
      expect(result.failures[0]!.reason).toMatch(/no adapter/i);
      expect(ledger.getState(itemId(ref))).toBe('FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-package mix: success, skip (ledger), skip (already_present), failure
  // -------------------------------------------------------------------------
  describe('multi-package mixed scenario', () => {
    it('correctly categorises each package', async () => {
      const alreadyInLedger = makeRef('in-ledger', '1.0.0');
      const alreadyOnArtifactory = makeRef('on-artifactory', '2.0.0');
      const newUpload = makeRef('new-pkg', '3.0.0');
      const failedUpload = makeRef('bad-pkg', '4.0.0');

      // Upload call order: alreadyOnArtifactory, newUpload, then failedUpload × 3
      const adapter = makeAdapter('npm', [
        { kind: 'already_present' },                              // alreadyOnArtifactory
        { kind: 'uploaded' },                                     // newUpload
        { kind: 'failed', reason: 'err' },                        // failedUpload attempt 1
        { kind: 'failed', reason: 'err' },                        // failedUpload attempt 2
        { kind: 'failed', reason: 'err' },                        // failedUpload attempt 3
      ]);

      const ledger = new ImportLedgerService('bundle-1');
      ledger.record(itemId(alreadyInLedger), 'IMPORTED');

      const importer = new PackageImporter(new Map([['npm', adapter]]));

      const result = await importer.importPackages(
        [
          makeArtifact(alreadyInLedger),
          makeArtifact(alreadyOnArtifactory),
          makeArtifact(newUpload),
          makeArtifact(failedUpload),
        ],
        ledger,
      );

      expect(result.skipped).toContainEqual(alreadyInLedger);
      expect(result.skipped).toContainEqual(alreadyOnArtifactory);
      expect(result.uploaded).toEqual([newUpload]);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.itemId).toBe(itemId(failedUpload));
      expect(result.haltedByLedgerFailure).toBeUndefined();

      // Ledger states
      expect(ledger.getState(itemId(alreadyInLedger))).toBe('IMPORTED');   // unchanged
      expect(ledger.getState(itemId(alreadyOnArtifactory))).toBe('PRESENT');
      expect(ledger.getState(itemId(newUpload))).toBe('IMPORTED');
      expect(ledger.getState(itemId(failedUpload))).toBe('FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // Ecosystem routing (Requirement 4.2)
  // -------------------------------------------------------------------------
  describe('ecosystem routing', () => {
    it('routes npm packages through the npm adapter', async () => {
      const npmRef = makeRef('axios', '1.0.0', 'npm');
      const npmAdapter = makeAdapter('npm', [{ kind: 'uploaded' }]);

      const importer = new PackageImporter(new Map([['npm', npmAdapter]]));
      const ledger = new ImportLedgerService('bundle-1');

      const result = await importer.importPackages([makeArtifact(npmRef)], ledger);

      expect(result.uploaded).toEqual([npmRef]);
      expect(npmAdapter.upload).toHaveBeenCalledWith(npmRef, expect.any(Buffer));
    });

    it('routes Python packages through the Python adapter', async () => {
      const pyRef: PackageRef = makeRef('requests', '2.28.0', 'Python');
      const pyAdapter = makeAdapter('Python', [{ kind: 'uploaded' }]);

      const importer = new PackageImporter(new Map([['Python', pyAdapter]]));
      const ledger = new ImportLedgerService('bundle-1');

      const result = await importer.importPackages([makeArtifact(pyRef)], ledger);

      expect(result.uploaded).toEqual([pyRef]);
      expect(pyAdapter.upload).toHaveBeenCalledWith(pyRef, expect.any(Buffer));
    });

    it('handles mixed npm and Python packages in one call', async () => {
      const npmRef = makeRef('lodash', '4.0.0', 'npm');
      const pyRef: PackageRef = makeRef('numpy', '1.24.0', 'Python');

      const npmAdapter = makeAdapter('npm', [{ kind: 'uploaded' }]);
      const pyAdapter = makeAdapter('Python', [{ kind: 'uploaded' }]);

      const importer = new PackageImporter(
        new Map<Ecosystem, EcosystemAdapter>([
          ['npm', npmAdapter],
          ['Python', pyAdapter],
        ]),
      );
      const ledger = new ImportLedgerService('bundle-1');

      const result = await importer.importPackages(
        [makeArtifact(npmRef), makeArtifact(pyRef)],
        ledger,
      );

      expect(result.uploaded).toContainEqual(npmRef);
      expect(result.uploaded).toContainEqual(pyRef);
      expect(npmAdapter.upload).toHaveBeenCalledWith(npmRef, expect.any(Buffer));
      expect(pyAdapter.upload).toHaveBeenCalledWith(pyRef, expect.any(Buffer));
    });
  });

  // -------------------------------------------------------------------------
  // Empty package list
  // -------------------------------------------------------------------------
  describe('empty package list', () => {
    it('returns empty result without error', async () => {
      const importer = new PackageImporter(new Map());
      const ledger = new ImportLedgerService('bundle-1');

      const result = await importer.importPackages([], ledger);

      expect(result.uploaded).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(result.haltedByLedgerFailure).toBeUndefined();
    });
  });
});
