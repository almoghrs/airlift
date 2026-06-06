# Implementation Plan: Airgap Package Sync Pipeline

## Overview

This plan implements the pipeline in **Node.js (current LTS) with TypeScript**, using **fast-check** for property-based tests (minimum 100 iterations per property, each tagged `// Feature: airgap-package-sync-pipeline, Property {n}: {text}`). Git operations shell out to the native `git` CLI via `child_process`. JFrog Artifactory and GitLab are reached over their REST APIs and are mocked at their boundaries in property tests.

The work is sequenced so **V1 (full-snapshot) is completed and shippable before any V2 (incremental) task begins**. The shared components (Manifest validation, `EcosystemAdapter` for npm + Python, `BundleWriter`/`BundleReader` + Integrity, `GitImporter`, `PackageImporter`, `ImportLedger`, `ReportBuilder`) are built as part of V1 and reused unchanged by V2. V2 is purely additive: it adds `SyncStateStore`, `IncrementalStrategy`, and incremental `GitPacker` behavior, plus the V2-only report indications.

All 19 correctness properties are implemented as fast-check property tests, complemented by the example/edge unit tests and integration tests from the design's Testing Strategy. Test sub-tasks are marked optional with `*`.

---

## Tasks

### V1 — Full-Snapshot Delivery (shippable on its own)

> All tasks in sections 1–12 deliver V1 together with the Common Requirements (Requirements 1–8). V1 performs no change tracking. The components built here are reused unchanged by V2.

- [x] 1. Set up project structure and core data models
  - [x] 1.1 Initialize Node/TypeScript project and test tooling
    - Create the Node.js (LTS) + TypeScript project (`package.json`, `tsconfig.json`, `src/`, `test/`)
    - Add and configure the test runner and **fast-check** as the property-based testing library
    - Add a script that runs all tests; document the `numRuns` >= 100 convention for property tests
    - _Requirements: foundational (no AC); enables all subsequent tasks_

  - [x] 1.2 Define core data model types and interfaces
    - Implement TypeScript types for `Manifest`, `TrackedProject`, `PackageCoordinate`, `PackageRef`, `PackageArtifact`, `GitBundleArtifact`, `TransferBundle`, `BundleDescriptor`, `ProjectCheckpoint`, `RetrievalFailure`, `ImportLedger`, `SyncReport`, `ProjectReport`, `ItemFailure`
    - Define enums/union types for ecosystem (`npm` | `Python`), manifest status (`VALID` | `INVALID`), overall status, and ledger item state (`IMPORTED` | `PRESENT` | `FAILED`)
    - _Requirements: 1.1, 2.2, 5.1, 5.2, 5.5_

- [x] 2. Implement Manifest loader and validator
  - [x] 2.1 Implement `ManifestValidator.load`
    - Parse the Manifest file and run all structural/semantic validation rules, collecting (not short-circuiting) every error
    - Enforce: 1..1000 projects; unique project id of 1..128 chars; non-empty git location; 0..1000 package coordinates; ecosystem ∈ {npm, Python}
    - Set status `VALID` on success; on failure set `INVALID` and report duplicated ids, missing field names with project id, unsupported ecosystem values with project id + coordinates, and "no Tracked_Projects" for empty manifests
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x]* 2.2 Write property test for manifest validity
    - **Property 1: Manifest validity equals constraint satisfaction**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.7, 1.9**
    - Use a Manifest arbitrary covering boundaries (0/1/1000/1001 projects, id lengths 0/1/128/129, empty git location, 0/1000/1001 coordinates, ecosystems from {npm, Python, arbitrary strings})

  - [x]* 2.3 Write property test for precise defect reporting
    - **Property 2: Manifest defects are reported precisely**
    - **Validates: Requirements 1.6, 1.8**
    - Inject duplicate ids and dropped required fields; assert reported errors include the duplicated id / project id + missing field name

  - [x]* 2.4 Write unit test for parse-failure line/column reporting
    - Assert an unparseable Manifest yields `INVALID` with an error identifying the line and column of the parse failure
    - _Requirements: 1.10_

- [x] 3. Implement integrity service and bundle serialization
  - [x] 3.1 Implement `IntegrityService`
    - Compute SHA-256 over a canonical serialization of bundle contents: every Git_Bundle, every package file, and descriptor metadata **excluding** the integrity value field
    - Provide `compute` and `verify`
    - _Requirements: 2.3, 2.4_

  - [x] 3.2 Implement `BundleWriter`
    - Serialize git bundles, package files, and descriptor into a single Transfer_Bundle; compute and embed the integrity value; assign a unique-per-Packer bundle id
    - Record per-project target commit references and every packed Package_Version (coordinates, version, ecosystem) plus retrieval failures in the descriptor
    - _Requirements: 2.1, 2.2, 2.3, 7.4, 8.4_

  - [x] 3.3 Implement `BundleReader`
    - Load a Transfer_Bundle and recompute integrity over the loaded contents before exposing any content
    - Reject (exposing nothing) when integrity mismatches, or the descriptor is absent, unparseable, or missing an integrity value
    - _Requirements: 2.4, 2.5, 2.6_

  - [x]* 3.4 Write property test for bundle round-trip
    - **Property 3: Transfer_Bundle round-trip preserves contents and checkpoints**
    - **Validates: Requirements 2.1, 2.2, 7.4, 8.4, 10.5, 11.6**

  - [x]* 3.5 Write property test for bundle id uniqueness
    - **Property 4: Bundle identifiers are unique per Packer**
    - **Validates: Requirements 2.2**

  - [x]* 3.6 Write property test for integrity verification and tamper gating
    - **Property 5: Integrity verification detects tampering and gates all destination writes**
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6**
    - Use a tamper arbitrary that mutates a random byte of a random content region, plus absent/unparseable/integrity-missing descriptor cases; assert no destination writes occur on rejection

- [x] 4. Implement ecosystem adapters (npm + Python)
  - [x] 4.1 Define `EcosystemAdapter` interface
    - Declare `ecosystem`, `discover_versions`, `parse_dependencies`, `download`, `upload`, `target_repository_kind`
    - _Requirements: 1.4, 4.2, 8.1, 8.3_

  - [x] 4.2 Implement `NpmAdapter`
    - Discover versions via Artifactory; parse dependency union of `dependencies` + `optionalDependencies` + `peerDependencies` from `package.json`; download `.tgz`; upload to the npm repo; `target_repository_kind` = `npm`
    - _Requirements: 4.2, 8.1, 8.3_

  - [x] 4.3 Implement `PythonAdapter`
    - Discover versions via Artifactory; parse `Requires-Dist` specifiers from METADATA/PKG-INFO resolving markers/extras to concrete available versions; download wheels/sdists; upload to the PyPI repo; `target_repository_kind` = `pypi`
    - _Requirements: 4.2, 8.1, 8.3_

  - [x]* 4.4 Write integration tests for Source_Artifactory access (per ecosystem)
    - npm version discovery (AQL) + `.tgz` download; Python version discovery + wheel/sdist download, against a mocked or ephemeral Artifactory (1 example per ecosystem)
    - _Requirements: 8.1_

- [x] 5. Implement dependency resolver (shared, full closure)
  - [x] 5.1 Implement `DependencyResolver`
    - Worklist algorithm with a `visited` set keyed by `(ecosystem, coordinates, version)`; seed from discovered roots; retrieve each version; parse deps via the ecosystem adapter; enqueue unvisited deps; dedup and guarantee termination on cycles
    - Apply an injectable include-filter (V1 = include all); record retrieval failures and continue
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6, 8.7_

  - [x]* 5.2 Write property test for resolution termination and dedup
    - **Property 6: Transitive dependency resolution terminates and deduplicates**
    - **Validates: Requirements 8.3, 8.5, 11.3, 11.7**
    - Use a dependency-graph arbitrary including cycles and diamonds across both ecosystems

  - [x]* 5.3 Write property test for retrieval-failure handling
    - **Property 8: Retrieval failures are excluded, recorded, and non-blocking**
    - **Validates: Requirements 8.6, 8.7, 11.8, 11.9**
    - Use an injectable "unretrievable" subset; assert unretrievable versions are absent + recorded and every other reachable version is still included

- [x] 6. Implement git packing (full snapshot)
  - [x] 6.1 Implement `GitPacker` full-history packing
    - Shell out to `git bundle create <file> --all` to produce a `GitBundleArtifact` with full history of tracked refs; record target commit reference per ref
    - On failure, return a failure outcome that excludes the project and reports the project id, leaving other projects unaffected
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x]* 6.2 Write property test for git production failure isolation
    - **Property 9: Git bundle production failure excludes only the affected project**
    - **Validates: Requirements 7.5, 10.7**
    - Inject failures for an arbitrary subset of projects; assert exactly those are excluded and reported while others are produced

  - [x]* 6.3 Write property test for V1 full-history reconstruction
    - **Property 10: V1 full-history bundles reconstruct every ref from empty**
    - **Validates: Requirements 7.1, 7.2, 7.3, 3.1, 3.2**
    - Build small synthetic repos via the real `git` CLI; apply each bundle to an empty local bare repo and assert every tracked ref matches the recorded target commit

- [x] 7. Implement packing strategy and Packer orchestrator (V1)
  - [x] 7.1 Implement `PackingStrategy` interface and `FullSnapshotStrategy`
    - Define `name`, `git_baseline`, `package_filter`; `FullSnapshotStrategy` always returns `FULL` baseline and an include-all filter, never consulting Sync_State
    - _Requirements: 7.1, 7.2, 8.1, 8.2_

  - [x] 7.2 Implement Packer orchestrator (V1 wiring)
    - Load + validate Manifest (abort with failure report on INVALID); per project drive `GitPacker` and `DependencyResolver` through the selected strategy; assemble artifacts; invoke `BundleWriter`; emit the Pack Report
    - _Requirements: 1.5, 2.1, 5.1, 7.2, 8.2_

- [x] 8. Implement reporting (shared)
  - [x] 8.1 Implement `ReportBuilder`
    - Build Pack and Import reports including Sync_Run id, delivery version, per-project packed refs/versions with ecosystems, skipped/already-present items, and carry failures into every report of the run
    - Assign exactly one overall status; mark the run failed if report generation itself fails
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6, 3.7_

  - [x]* 8.2 Write property test for complete packed/imported listing
    - **Property 17: Reports completely list packed and imported items** (V1 reporting scope)
    - **Validates: Requirements 5.1, 5.2, 5.3**
    - (V2 empty-project indications are added in task 16.2)

  - [x]* 8.3 Write property test for failure propagation across reports
    - **Property 18: Failures propagate into every report of the run**
    - **Validates: Requirements 5.4**

  - [x]* 8.4 Write property test for overall status classification
    - **Property 19: Overall status is a single correct classification**
    - **Validates: Requirements 5.5, 3.7**
    - Use a status-input arbitrary of random completed/failed + skipped/failed item combinations

  - [x]* 8.5 Write unit test for report-generation failure
    - Assert that a report-generation failure marks the Sync_Run failed and surfaces a report-generation error
    - _Requirements: 5.6_

- [x] 9. Implement import ledger and git importer (shared)
  - [x] 9.1 Implement `ImportLedger`
    - Per-item ledger keyed by bundle id + item id recording `IMPORTED` | `PRESENT` | `FAILED`; query and update operations
    - _Requirements: 6.2, 6.4_

  - [x] 9.2 Implement `GitImporter`
    - Create the destination repo if absent (skip + report + continue on creation failure); `git fetch <bundle>` retaining existing refs/commits; set refs to recorded target commits only after a full successful fetch; on apply failure roll back to pre-application refs, report, and continue
    - Consult the ledger first and skip already-imported bundles
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.2, 6.3, 6.5_

  - [x]* 9.3 Write property test for history retention
    - **Property 12: Importing retains previously imported history**
    - **Validates: Requirements 3.3**

  - [x]* 9.4 Write property test for atomic ref updates
    - **Property 14: Ref updates are atomic with respect to bundle application**
    - **Validates: Requirements 3.5, 6.3, 6.5**
    - Simulate interruption/failure before full application; assert refs stay at pre-application state and remaining bundles continue processing

- [x] 10. Implement package importer (shared)
  - [x] 10.1 Implement `PackageImporter`
    - Skip + record "already present" when coordinates+version+ecosystem already on Destination_Artifactory or in ledger; upload to the ecosystem-matching repo with a 300s per-attempt cap and up to 3 attempts
    - On success record imported; if recording fails, halt package processing, report, and retain prior records; on upload failure/timeout after retries, report, leave prior uploads unchanged, and continue
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 10.2 Write property test for ecosystem-matched routing
    - **Property 15: Packages route to the ecosystem-matching repository**
    - **Validates: Requirements 4.2**

  - [x]* 10.3 Write unit test for repo-creation-failure isolation
    - Assert a repo creation failure skips that bundle, reports the project, and continues with remaining bundles
    - _Requirements: 3.6_

  - [x]* 10.4 Write unit test for ledger-write-failure halting
    - Assert a ledger-write failure after a successful upload halts package processing immediately, reports the affected package, and retains already-recorded items
    - _Requirements: 4.5_

- [x] 11. Implement Importer orchestrator (V1) and idempotency
  - [x] 11.1 Implement Importer orchestrator wiring
    - Load bundle via `BundleReader` (reject with zero writes on integrity/descriptor failure); process each Git_Bundle then each Package_Version through ledger/importers; emit the Import Report with overall status
    - Report git import as "succeeded with skipped or failed items" when any bundle was skipped/failed
    - _Requirements: 2.4, 2.5, 2.6, 3.7, 5.2, 6.1, 6.4_

  - [x]* 11.2 Write property test for idempotent, resumable import
    - **Property 13: Import is idempotent and resumable**
    - **Validates: Requirements 6.1, 6.2, 6.4, 4.3, 4.4**
    - Assert running once vs repeated yields identical state; each ref equals recorded target; each Package_Version present exactly once; all-already-imported bundles skip every item

- [x] 12. V1 integration, end-to-end smoke, and checkpoint
  - [x]* 12.1 Write Destination_Artifactory and Destination_GitLab integration tests
    - npm upload to npm repo, Python upload to PyPI repo, skip-if-present detection, 300s timeout + 3-attempt retry behavior; GitLab project creation, authenticated bundle push, ref application, rollback on push failure (mocked/ephemeral, 1–3 examples each)
    - _Requirements: 4.1, 4.6, 3.2, 3.5_

  - [x]* 12.2 Write V1 end-to-end smoke test
    - Pack a minimal Manifest with V1 and import it against mocked Artifactory/GitLab; assert overall report status
    - _Requirements: 5.1, 5.2, 5.5_

  - [x] 12.3 Checkpoint — V1 complete and shippable
    - Ensure all tests pass, ask the user if questions arise.

### V2 — Incremental Efficiency (layered on top of V1)

> V2 reuses every shared component above unchanged. It adds `SyncStateStore`, `IncrementalStrategy`, incremental `GitPacker` behavior, the incremental package filter, and the V2-only report indications. Do not begin these tasks until V1 (sections 1–12) is complete.

- [ ] 13. Implement Sync_State store (V2)
  - [ ] 13.1 Implement `SyncStateStore`
    - `load` per-project baselines (last packed commit, packed versions); `persist` atomically so that after a failed write either the complete updated state or the complete prior state is readable; on packing/persistence failure retain the prior baseline for every project
    - _Requirements: 9.1, 9.3, 9.4_

  - [ ]* 13.2 Write property test for atomic Sync_State persistence
    - **Property 16: Sync_State persistence is atomic**
    - **Validates: Requirements 9.1, 9.4**
    - Inject failure at arbitrary points; assert readable state is never a partial mixture and prior baseline is retained on failure

- [ ] 14. Implement incremental git packing (V2)
  - [ ] 14.1 Extend `GitPacker` for incremental packing
    - Support `SINCE(commit)` baseline via `git bundle create <file> <refs> --not <commit>`; record source + target commit references; return `SkipNoChanges` ("no git changes packed") when no new commits and no full pack required; still produce a bundle when a full pack is required
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ] 14.2 Implement `IncrementalStrategy`
    - Consult Sync_State to compute per-project baselines; fall back to `FULL` when no prior state (9.2), the recorded commit is missing (9.5), or the state is unreadable (9.6), reporting the affected project; otherwise `SINCE(lastCommit)`
    - _Requirements: 9.2, 9.5, 9.6, 10.1, 10.2_

  - [ ]* 14.3 Write property test for incremental git reconstruction and baseline selection
    - **Property 11: V2 incremental packing reconstructs target refs and selects the correct baseline**
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.6, 9.2, 9.5, 9.6**
    - Build repos with prior imports + additional commits via the real `git` CLI; assert correct baseline choice and that applying the incremental bundle on existing history reconstructs each target ref, with no bundle when no new commits and no full pack required

- [ ] 15. Implement incremental package filtering (V2)
  - [ ] 15.1 Extend resolver/strategy package filter for V2
    - `IncrementalStrategy.package_filter` includes only versions not recorded in Sync_State as already packed; drop transitive deps already recorded as packed; include deps not recorded; continue to record retrieval failures
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [ ]* 15.2 Write property test for incremental package filtering
    - **Property 7: Incremental package filter excludes already-packed versions**
    - **Validates: Requirements 11.1, 11.2, 11.4, 11.5**
    - Use a dependency-graph arbitrary plus an injectable "already-packed" subset; assert included set is exactly the retrievable reachable versions not already packed

- [ ] 16. V2 reporting, wiring, and checkpoint
  - [ ] 16.1 Extend `ReportBuilder` and wire the V2 Packer
    - Add V2-only explicit indications "no git changes packed" and "no Package_Versions packed" for empty projects; select `IncrementalStrategy` + `SyncStateStore` in the Packer orchestrator and persist updated Sync_State on successful packing
    - _Requirements: 5.3, 9.1, 9.3_

  - [ ]* 16.2 Extend Property 17 test for V2 empty-project indications
    - **Property 17: Reports completely list packed and imported items** (V2 empty-project scope)
    - **Validates: Requirements 5.3**

  - [ ]* 16.3 Write V2 end-to-end smoke test
    - Pack a minimal Manifest with V2 (initial full pack then incremental run) and import against mocked Artifactory/GitLab; assert overall report status and incremental behavior
    - _Requirements: 5.1, 5.3, 9.3, 10.4_

  - [ ] 16.4 Checkpoint — V2 complete
    - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, but they implement the 19 correctness properties and the example/edge + integration tests from the design's Testing Strategy.
- Each property test is a single fast-check test with `numRuns` >= 100, tagged `// Feature: airgap-package-sync-pipeline, Property {n}: {text}`.
- Sections 1–12 deliver V1 and are shippable independently; sections 13–16 layer V2 on top, reusing all shared components unchanged.
- Property 17 spans both versions: its V1 reporting scope is tested in 8.2 and its V2 empty-project scope in 16.2.
- Each task references the specific requirements and/or correctness properties it implements.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "4.2", "4.3"] },
    { "id": 4, "tasks": ["3.4", "3.5", "3.6", "4.4", "5.1", "8.1", "9.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.1", "8.2", "8.3", "8.4", "8.5", "9.2", "10.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "7.1", "9.3", "9.4", "10.2", "10.3", "10.4"] },
    { "id": 7, "tasks": ["7.2", "11.1"] },
    { "id": 8, "tasks": ["11.2", "12.1", "12.2"] },
    { "id": 9, "tasks": ["13.1"] },
    { "id": 10, "tasks": ["13.2", "14.1", "15.1"] },
    { "id": 11, "tasks": ["14.2", "15.2"] },
    { "id": 12, "tasks": ["14.3", "16.1"] },
    { "id": 13, "tasks": ["16.2", "16.3"] }
  ]
}
```
