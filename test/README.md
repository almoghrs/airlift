# Test Directory

This directory contains integration and end-to-end tests for the Airgap Package Sync Pipeline.
Unit tests co-located with source files use the `.test.ts` suffix inside `src/`.

## Property-Based Testing Conventions

All property-based tests in this project use **fast-check**.

### numRuns convention

Every `fc.assert(fc.property(...))` call **MUST** pass `{ numRuns: 100 }` (or higher) as the
options argument. The default fast-check `numRuns` (100 as of fc v3) is acceptable, but setting
it explicitly makes the intent clear and prevents accidental regressions when the default changes.

```typescript
fc.assert(
  fc.property(someArbitrary, (input) => {
    // ... property body
  }),
  { numRuns: 100 },
);
```

### Tagging convention

Every property test file MUST include a tag comment identifying the feature and property number
immediately above the `fc.assert` call:

```typescript
// Feature: airgap-package-sync-pipeline, Property {n}: {short description}
fc.assert(
  fc.property(...),
  { numRuns: 100 },
);
```

### File locations

| Test kind            | Location                          | Suffix        |
| -------------------- | --------------------------------- | ------------- |
| Unit / example tests | `src/**/*.test.ts`                | `.test.ts`    |
| Property-based tests | `src/**/*.test.ts` (co-located)   | `.test.ts`    |
| Integration tests    | `test/**/*.test.ts`               | `.test.ts`    |
| E2E smoke tests      | `test/**/*.e2e.test.ts`           | `.e2e.test.ts`|
