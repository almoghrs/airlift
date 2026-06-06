/**
 * Setup smoke test — verifies the test runner and fast-check are wired correctly.
 * This file is intentionally minimal and can be removed once real tests exist.
 */

import * as fc from 'fast-check';

describe('project setup', () => {
  it('jest is configured correctly', () => {
    expect(true).toBe(true);
  });

  it('fast-check is available and runs property tests', () => {
    // Feature: airgap-package-sync-pipeline, Property 0: setup smoke (numRuns >= 100 convention)
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        // Commutativity of addition — a trivial property to verify the runner works
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
