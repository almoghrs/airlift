/**
 * Import Ledger — destination-side per-item state tracking.
 *
 * Maintains a per-item ledger keyed by bundle id + item id, recording whether
 * each item is IMPORTED, PRESENT, or FAILED. Enables idempotent and resumable
 * imports by allowing the orchestrator to skip items already completed.
 *
 * Requirements: 6.2, 6.4
 *
 * Item ID conventions:
 *   - Git bundles:  projectId (e.g. "my-project")
 *   - Packages:    "<ecosystem>:<coordinates>@<version>" (e.g. "npm:lodash@4.17.21")
 */

import type { ImportLedger, LedgerItemState } from '../types/index.js';

export class ImportLedgerService {
  private ledger: ImportLedger;

  constructor(bundleId: string) {
    this.ledger = { bundleId, items: {} };
  }

  /**
   * Check if an item has been successfully completed — either IMPORTED or
   * PRESENT. Both states mean "no action needed on re-run" (Requirement 6.2).
   */
  isCompleted(itemId: string): boolean {
    const state = this.ledger.items[itemId];
    return state === 'IMPORTED' || state === 'PRESENT';
  }

  /**
   * Get the current recorded state of an item, or undefined if not yet recorded.
   */
  getState(itemId: string): LedgerItemState | undefined {
    return this.ledger.items[itemId];
  }

  /**
   * Record an item's state (IMPORTED, PRESENT, or FAILED).
   *
   * This in-memory implementation always succeeds. The interface is designed
   * to allow a persistence-backed implementation in the future (Requirement 6.4).
   */
  record(itemId: string, state: LedgerItemState): void {
    this.ledger.items[itemId] = state;
  }

  /**
   * Return all item IDs whose current state matches the given state.
   */
  getItemsByState(state: LedgerItemState): string[] {
    return Object.entries(this.ledger.items)
      .filter(([, s]) => s === state)
      .map(([id]) => id);
  }

  /**
   * Return an immutable snapshot of the full ledger — useful for persistence
   * or reporting (Requirement 6.4).
   *
   * Returns a deep copy so callers cannot mutate internal state.
   */
  snapshot(): ImportLedger {
    return {
      bundleId: this.ledger.bundleId,
      items: { ...this.ledger.items },
    };
  }
}
