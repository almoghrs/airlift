/**
 * Unit tests for ImportLedgerService.
 *
 * Requirements: 6.2, 6.4
 */

import { ImportLedgerService } from './import-ledger';

describe('ImportLedgerService', () => {
  let ledger: ImportLedgerService;

  beforeEach(() => {
    ledger = new ImportLedgerService('bundle-001');
  });

  // -------------------------------------------------------------------------
  // isCompleted
  // -------------------------------------------------------------------------

  describe('isCompleted', () => {
    it('returns false for an item that has never been recorded', () => {
      expect(ledger.isCompleted('unknown-item')).toBe(false);
    });

    it('returns true for an IMPORTED item', () => {
      ledger.record('proj-a', 'IMPORTED');
      expect(ledger.isCompleted('proj-a')).toBe(true);
    });

    it('returns true for a PRESENT item', () => {
      ledger.record('npm:lodash@4.17.21', 'PRESENT');
      expect(ledger.isCompleted('npm:lodash@4.17.21')).toBe(true);
    });

    it('returns false for a FAILED item', () => {
      ledger.record('proj-b', 'FAILED');
      expect(ledger.isCompleted('proj-b')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getState
  // -------------------------------------------------------------------------

  describe('getState', () => {
    it('returns undefined for an unrecorded item', () => {
      expect(ledger.getState('ghost')).toBeUndefined();
    });

    it('returns the recorded state', () => {
      ledger.record('pkg', 'IMPORTED');
      expect(ledger.getState('pkg')).toBe('IMPORTED');
    });
  });

  // -------------------------------------------------------------------------
  // record
  // -------------------------------------------------------------------------

  describe('record', () => {
    it('records a new item state', () => {
      ledger.record('proj-x', 'IMPORTED');
      expect(ledger.getState('proj-x')).toBe('IMPORTED');
    });

    it('overwrites an existing state when called again with the same item id', () => {
      ledger.record('proj-x', 'FAILED');
      expect(ledger.getState('proj-x')).toBe('FAILED');

      // Re-try succeeded — overwrite with IMPORTED
      ledger.record('proj-x', 'IMPORTED');
      expect(ledger.getState('proj-x')).toBe('IMPORTED');
    });

    it('can overwrite IMPORTED back to FAILED', () => {
      ledger.record('item', 'IMPORTED');
      ledger.record('item', 'FAILED');
      expect(ledger.getState('item')).toBe('FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // getItemsByState
  // -------------------------------------------------------------------------

  describe('getItemsByState', () => {
    beforeEach(() => {
      ledger.record('proj-a', 'IMPORTED');
      ledger.record('proj-b', 'PRESENT');
      ledger.record('proj-c', 'FAILED');
      ledger.record('proj-d', 'IMPORTED');
    });

    it('returns only IMPORTED items', () => {
      const result = ledger.getItemsByState('IMPORTED');
      expect(result).toHaveLength(2);
      expect(result).toContain('proj-a');
      expect(result).toContain('proj-d');
    });

    it('returns only PRESENT items', () => {
      const result = ledger.getItemsByState('PRESENT');
      expect(result).toEqual(['proj-b']);
    });

    it('returns only FAILED items', () => {
      const result = ledger.getItemsByState('FAILED');
      expect(result).toEqual(['proj-c']);
    });

    it('returns an empty array when no items match the given state', () => {
      const emptyLedger = new ImportLedgerService('bundle-empty');
      expect(emptyLedger.getItemsByState('IMPORTED')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  describe('snapshot', () => {
    it('returns a copy of the full ledger including bundleId', () => {
      ledger.record('proj-a', 'IMPORTED');
      ledger.record('npm:react@18.0.0', 'PRESENT');

      const snap = ledger.snapshot();

      expect(snap.bundleId).toBe('bundle-001');
      expect(snap.items['proj-a']).toBe('IMPORTED');
      expect(snap.items['npm:react@18.0.0']).toBe('PRESENT');
    });

    it('snapshot is a copy — mutating it does not affect the ledger', () => {
      ledger.record('proj-a', 'IMPORTED');

      const snap = ledger.snapshot();
      // Mutate the snapshot
      snap.items['proj-a'] = 'FAILED';
      snap.items['new-item'] = 'PRESENT';

      // Ledger internals must be unchanged
      expect(ledger.getState('proj-a')).toBe('IMPORTED');
      expect(ledger.getState('new-item')).toBeUndefined();
    });

    it('snapshot reflects the state at the moment it is called', () => {
      ledger.record('proj-a', 'IMPORTED');
      const snapBefore = ledger.snapshot();

      ledger.record('proj-b', 'FAILED');
      const snapAfter = ledger.snapshot();

      // The earlier snapshot should NOT include the later addition
      expect(snapBefore.items['proj-b']).toBeUndefined();
      // The later snapshot should include both
      expect(snapAfter.items['proj-a']).toBe('IMPORTED');
      expect(snapAfter.items['proj-b']).toBe('FAILED');
    });
  });
});
