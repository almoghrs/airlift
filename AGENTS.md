# AGENTS.md — Guide for AI Agents

This document describes the codebase structure, conventions, and rules that AI agents should follow when working in this repository.

## Project overview

Airlift is a TypeScript/Node.js pipeline that syncs open source assets (git repos + npm/Python packages) from an internet-connected source into an air-gapped destination. The source side packs everything into a SHA-256-protected Transfer_Bundle; the destination side unpacks it idempotently.

Full context: [`README.md`](README.md), spec under `.kiro/specs/airgap-package-sync-pipeline/`.

## Repository layout

```
src/
  packer/
    packer.ts              # Packer orchestrator — entry point for the source side
    packing-strategy.ts    # PackingStrategy interface + FullSnapshotStrategy (V1)
    git-packer.ts          # Shells out to `git bundle create`
    npm-adapter.ts         # EcosystemAdapter for npm
    python-adapter.ts      # EcosystemAdapter for Python (PyPI)
    index.ts
  importer/
    importer.ts            # Importer orchestrator — entry point for the destination side
    git-importer.ts        # git fetch + atomic ref updates + rollback
    package-importer.ts    # Upload to Artifactory, 300s timeout, 3 retries
    import-ledger.ts       # Per-item IMPORTED/PRESENT/FAILED state
    index.ts
  shared/
    manifest-validator.ts  # Load + validate Manifest JSON
    integrity-service.ts   # SHA-256 over canonical bundle contents
    bundle-writer.ts       # Serialize TransferBundle to JSON (base64 binaries)
    bundle-reader.ts       # Deserialize + verify integrity before exposing content
    dependency-resolver.ts # BFS worklist with visited-set for transitive closure
    ecosystem-adapter.ts   # EcosystemAdapter interface + supporting types
    report-builder.ts      # Build Pack/Import reports with overall status
    index.ts
  types/
    index.ts               # All core types — read this first when navigating the model
test/
  README.md                # Testing conventions (fast-check numRuns, tagging, file locations)
  setup.test.ts
```

## Build and test commands

```bash
npm run build          # tsc compile → dist/
npm test               # jest --runInBand (all tests, serial)
npm run test:coverage  # with coverage
```

Always run `npm run build` after edits and confirm zero TypeScript errors before considering a task done. Run `npm test` to confirm tests pass.

## TypeScript configuration

- `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`
- Target: ES2022, module: CommonJS
- Do not disable strict flags to work around type errors — fix the types properly.

## Core design decisions to respect

### 1. PackingStrategy is the only V1/V2 seam

`PackingStrategy` (in `src/packer/packing-strategy.ts`) controls:
- `gitBaseline(project)` → whether to do a full or incremental git pack
- `packageFilter(project)` → which package versions to include

Everything downstream (BundleWriter, BundleReader, Importer, ReportBuilder) is version-agnostic. Do not introduce V1/V2 branching outside of `PackingStrategy` and `SyncStateStore`.

### 2. EcosystemAdapter isolates npm/Python differences

All ecosystem-specific behavior (version discovery, dependency parsing, download, upload, target repo kind) belongs in `NpmAdapter` or `PythonAdapter`. `DependencyResolver` and `PackageImporter` are written against the `EcosystemAdapter` interface and must remain ecosystem-agnostic.

### 3. Integrity gates all destination writes

`BundleReader.read()` returns either `{ bundle }` or `{ reject }`. The `Importer` must never write to GitLab or Artifactory before receiving a valid `{ bundle }`. Do not bypass or defer this check.

### 4. Imports must be idempotent

Every import path goes through `ImportLedgerService.isCompleted(itemId)` before acting. After a successful action, call `ledger.record(itemId, 'IMPORTED')`. After detecting prior presence, call `ledger.record(itemId, 'PRESENT')`. This is what makes re-runs safe.

### 5. Git ref updates are atomic

In `GitImporter`, refs are set to their target commits **only after** the full bundle fetch completes. Capture pre-fetch refs at the start and restore them on any failure. Never move a ref before the full fetch is confirmed.

## Data model

Start with `src/types/index.ts` — it defines every type. Key ones:

| Type | Purpose |
|------|---------|
| `Manifest` / `TrackedProject` | Configuration input |
| `PackageRef` | `{ coordinates, version, ecosystem }` — the universal package key |
| `PackageArtifact` | `PackageRef` + raw `fileBytes: Buffer` |
| `GitBundleArtifact` | `projectId` + `bundleFile: Buffer` + `targetCommits` map |
| `TransferBundle` | `gitBundles + packages + descriptor` |
| `BundleDescriptor` | Bundle metadata including `integrityValue` (SHA-256) |
| `ProjectCheckpoint` | Per-project packed commits + versions recorded in the descriptor |
| `ImportLedger` | `bundleId` + `items: Record<itemId, LedgerItemState>` |
| `PackReport` / `ImportReport` | extend `SyncReport` with side-specific fields |
| `OverallStatus` | `'succeeded fully'` / `'succeeded with skipped or failed items'` / `'failed'` |

## Error handling patterns

Follow the three error scopes already established:

- **Fail fast, no side effects**: manifest validation failures, integrity rejections — abort before any writes, return a failure report
- **Per-item isolation**: git bundle production failure, package retrieval failure, upload failure — record the failure, skip the item, continue with the rest
- **Halting errors**: ledger-write failure after a successful upload, Sync_State persistence failure, report-generation failure — halt the current phase, preserve already-recorded progress, mark run `'failed'`

## Testing conventions

- **Unit and property tests**: co-located in `src/**/*.test.ts`
- **Integration and e2e tests**: in `test/**/*.test.ts`
- **Property tests**: use `fast-check`, minimum `numRuns: 100`, tagged:
  ```typescript
  // Feature: airgap-package-sync-pipeline, Property N: <short description>
  fc.assert(fc.property(...), { numRuns: 100 });
  ```
- Mock Artifactory and GitLab at their adapter/client boundaries in unit/property tests
- Do not write property tests that reimplement fast-check internals

When adding a new feature, write tests at the appropriate level before or alongside the implementation. The 19 correctness properties in the design doc (`.kiro/specs/airgap-package-sync-pipeline/design.md`) define what must be property-tested.

## V2 implementation (not yet started)

Tasks 13–16 in `.kiro/specs/airgap-package-sync-pipeline/tasks.md` cover V2. Before starting V2 work:
1. Implement `SyncStateStore` (task 13)
2. Implement incremental `GitPacker` behavior — `SINCE(commit)` baseline (task 14.1)
3. Implement `IncrementalStrategy` consulting `SyncStateStore` (task 14.2)
4. Extend `packageFilter` to exclude already-packed versions (task 15)
5. Add V2 report indications and wire the strategy into `Packer` (task 16)

Do not modify any shared component for V2 purposes — V2 is purely additive.

## What to avoid

- Do not add HTTP client libraries — the adapters use Node built-ins (`https`/`http`)
- Do not disable TypeScript strict flags
- Do not introduce V1/V2 branching outside `PackingStrategy`
- Do not skip integrity verification or the ledger check
- Do not move git refs before the full bundle fetch completes
- Do not use `any` — use proper types or `unknown` with type guards
