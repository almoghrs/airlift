# Requirements Document

## Introduction

This feature defines an air-gap synchronization pipeline that mirrors open source assets from an internet-connected source environment into an isolated (air-gapped) destination environment. The pipeline tracks a configured set of open source projects on a source-side JFrog Artifactory and their associated git repositories, packs them into a self-contained transfer bundle, transfers the packaged assets across the air gap, and unpacks them on the destination side. On the destination side, git repositories (including full history) are published to a private GitLab instance, and package versions are uploaded to a destination JFrog Artifactory.

The pipeline supports two package ecosystems: npm packages and Python (PyPI/pip) libraries. Both ecosystems are hosted on the source-side JFrog Artifactory, packed into the transfer bundle, and uploaded to the destination-side JFrog Artifactory. Most pipeline behavior (identifying versions to pack, transitive dependency resolution, retrieval, upload, skip-if-present) applies uniformly to both ecosystems; behavior that genuinely differs between ecosystems (for example, the dependency metadata format and the target repository type) is called out explicitly.

The pipeline is delivered in two versions:

- **Version 1 (V1)** is the simple, full-snapshot delivery. On every Sync_Run it exports and compresses everything — the full git history of all tracked repositories and all package versions (npm and Python) and their full transitive dependencies — into the transfer bundle, carries it across the air gap, and imports it: git history is pushed to the private GitLab and all packages are uploaded to the destination Artifactory. V1 performs no change tracking and no incremental logic. V1 is self-contained and shippable on its own.
- **Version 2 (V2)** is the efficient, incremental delivery. It builds on V1 and adds synchronization state and change tracking so that each Sync_Run packs only the incremental git changes produced since the last successful packing run, and only the package versions and changed dependencies that are not already present on the destination side. V2 layers this incremental efficiency on top of V1; the import, integrity, reporting, and idempotency behavior is shared with V1.

The requirements below are organized into three groups: requirements common to both V1 and V2, requirements specific to V1 (full-snapshot packing), and requirements specific to V2 (incremental packing). Each requirement title is tagged with the delivery version it applies to. Where a V2 requirement supersedes V1 packing behavior, this is stated explicitly.

The air gap itself is assumed to be bridged by an out-of-band physical or manual transfer mechanism (for example, a removable medium or a one-way data diode). The pipeline produces a self-contained transfer bundle on the source side and consumes that bundle on the destination side; the act of physically moving the bundle across the gap is external to the pipeline.

## Glossary

- **Pipeline**: The overall air-gap package synchronization system composed of the Packer (source side) and the Importer (destination side).
- **V1**: The full-snapshot delivery version of the Pipeline that, on every Sync_Run, packs the complete git history of all tracked refs and all configured Package_Versions and their full transitive dependencies, without change tracking.
- **V2**: The incremental delivery version of the Pipeline that builds on V1 by adding Sync_State and change tracking, so that each Sync_Run packs only incremental git changes and only new or changed Package_Versions and their changed dependencies.
- **Packer**: The source-side component that reads tracked assets and produces a Transfer_Bundle.
- **Importer**: The destination-side component that consumes a Transfer_Bundle and publishes its contents to the Destination_GitLab and the Destination_Artifactory.
- **Source_Artifactory**: The internet-connected JFrog Artifactory instance hosting the open source npm packages and Python packages on the source side.
- **Destination_Artifactory**: The air-gapped JFrog Artifactory instance that receives uploaded npm and Python Package_Versions.
- **Destination_GitLab**: The air-gapped private GitLab instance that receives git repositories.
- **Tracked_Project**: An open source project configured for synchronization, consisting of a git repository and zero or more associated Packages.
- **Manifest**: A configuration artifact that lists the Tracked_Projects, their source git repository locations, and their associated Package_Coordinates and Package_Ecosystems.
- **Package**: A versioned open source software library managed by a supported Package_Ecosystem, identified by its Package_Ecosystem and Package_Coordinates.
- **Package_Ecosystem**: The package management ecosystem of a Package, which is one of npm or Python (PyPI/pip).
- **Package_Coordinates**: The ecosystem-qualified identifier of a Package (for example, an npm package name or a Python distribution name).
- **Package_Version**: A specific released version of a Package, identified by its Package_Coordinates and a version value.
- **Dependency_Metadata**: The ecosystem-specific declaration of a Package_Version's dependencies (for npm, the dependency fields of the package manifest; for Python, the distribution metadata dependency specifiers).
- **Transfer_Bundle**: A self-contained, integrity-protected package produced by the Packer containing the git data, Package_Version files, and a Bundle_Descriptor, intended to be carried across the air gap.
- **Bundle_Descriptor**: Metadata inside a Transfer_Bundle describing its contents, the synchronization checkpoints it covers, and integrity information.
- **Sync_State**: The persisted record on the source side capturing, per Tracked_Project, the last successfully packed git commit reference and the set of Package_Versions last packed. Sync_State applies to V2 only.
- **Git_Bundle**: A git packfile (for example, a `git bundle`) containing commits, refs, and history; in V1 it contains the full history of the tracked refs, and in V2 it contains the incremental history reachable since the last packed commit.
- **Air_Gap**: The physical/network isolation boundary between the source and destination environments, crossed only by an out-of-band transfer of a Transfer_Bundle.
- **Sync_Run**: A single end-to-end execution consisting of a packing operation on the source side and a corresponding import operation on the destination side.

## Requirements

The following requirements apply to both V1 and V2 unless their title states otherwise. V1-specific packing requirements appear under "V1 Requirements", and V2-specific incremental packing requirements appear under "V2 Requirements".

## Common Requirements (V1 and V2)

### Requirement 1: Configure Tracked Projects (V1 and V2)

**User Story:** As a release engineer, I want to declare which open source projects, git repositories, and packages are synchronized, so that the pipeline mirrors exactly the assets my air-gapped environment needs.

#### Acceptance Criteria

1. THE Pipeline SHALL read a single Manifest that defines each Tracked_Project, the source git repository location, and, for each associated Package, the Package_Coordinates and the Package_Ecosystem.
2. WHEN the Manifest is loaded, THE Pipeline SHALL validate that each Tracked_Project entry includes a unique project identifier of 1 to 128 characters, a non-empty git repository location, and 0 to 1000 Package_Coordinates entries.
3. WHEN the Manifest is loaded, THE Pipeline SHALL validate that the Manifest contains between 1 and 1000 Tracked_Project entries.
4. WHEN the Manifest is loaded, THE Pipeline SHALL validate that each Package_Coordinates entry declares a Package_Ecosystem of either npm or Python.
5. WHEN Manifest validation succeeds, THE Pipeline SHALL set the Manifest status to VALID.
6. IF the Manifest contains a duplicate project identifier, THEN THE Pipeline SHALL reject the Manifest, set the Manifest status to INVALID, and report the duplicated identifier.
7. IF a Package_Coordinates entry declares a Package_Ecosystem that is neither npm nor Python, THEN THE Pipeline SHALL reject the Manifest, set the Manifest status to INVALID, and report the affected project identifier, Package_Coordinates, and the unsupported Package_Ecosystem value.
8. IF the Manifest is missing a required field for a Tracked_Project, THEN THE Pipeline SHALL reject the Manifest, set the Manifest status to INVALID, and report the project identifier and the name of the missing field.
9. IF the Manifest contains zero Tracked_Project entries, THEN THE Pipeline SHALL reject the Manifest, set the Manifest status to INVALID, and report that the Manifest contains no Tracked_Projects.
10. IF the Manifest cannot be parsed, THEN THE Pipeline SHALL reject the Manifest, set the Manifest status to INVALID, and return an error that identifies the line and column of the parse failure.

### Requirement 2: Produce an Integrity-Protected Transfer Bundle (V1 and V2)

**User Story:** As a security officer, I want each transfer bundle to be self-contained and verifiable, so that I can trust what crosses the air gap.

#### Acceptance Criteria

1. WHEN packing completes, THE Packer SHALL produce a single Transfer_Bundle containing all included Git_Bundles, all included Package_Version files, and the Bundle_Descriptor.
2. THE Packer SHALL include in the Bundle_Descriptor a bundle identifier that is unique across all Transfer_Bundles produced by the Packer and, per Tracked_Project covered by the bundle, the source synchronization checkpoints (the packed git commit references and the packed Package_Versions with their Package_Ecosystems) the bundle covers.
3. THE Packer SHALL compute a single integrity value over the complete contents of the Transfer_Bundle (every included Git_Bundle, every included Package_Version file, and the Bundle_Descriptor metadata excluding the integrity value field itself) and record that integrity value in the Bundle_Descriptor.
4. WHEN the Importer loads a Transfer_Bundle, THE Importer SHALL recompute the integrity value over the loaded contents using the same scope defined for the recorded integrity value and compare it to the integrity value recorded in the Bundle_Descriptor before processing any contents.
5. IF the recomputed integrity value does not match the recorded integrity value, THEN THE Importer SHALL reject the Transfer_Bundle, report the verification failure with the bundle identifier, and leave the destination unchanged by publishing no contents to the Destination_GitLab or the Destination_Artifactory.
6. IF the Bundle_Descriptor is absent, cannot be parsed, or does not contain a recorded integrity value, THEN THE Importer SHALL reject the Transfer_Bundle, report the descriptor failure, and publish no contents to the Destination_GitLab or the Destination_Artifactory.

### Requirement 3: Import Git Repositories to Destination GitLab (V1 and V2)

**User Story:** As a release engineer, I want the packed git history published to our private GitLab, so that developers in the air-gapped network can use the repositories.

#### Acceptance Criteria

1. WHEN the Importer processes a verified Transfer_Bundle, THE Importer SHALL apply each included Git_Bundle to the Destination_GitLab repository identified by the project identifier recorded in the Bundle_Descriptor.
2. WHERE the target repository identified in the Bundle_Descriptor does not exist on the Destination_GitLab, THE Importer SHALL create the repository under that project identifier before applying the Git_Bundle.
3. WHEN applying a Git_Bundle to an existing repository, THE Importer SHALL add the new commits and refs from the Git_Bundle while retaining all commits and refs previously imported to that repository.
4. WHEN a Git_Bundle has been applied successfully, THE Importer SHALL set the destination repository refs to exactly match the target commit references recorded in the Bundle_Descriptor for that Git_Bundle.
5. IF applying a Git_Bundle to a repository fails, THEN THE Importer SHALL restore the destination repository refs to their pre-application state, report the affected project identifier and the failure reason, and continue processing the remaining Git_Bundles.
6. IF creating a repository on the Destination_GitLab fails, THEN THE Importer SHALL skip applying that repository's Git_Bundle, report the affected project identifier and the failure reason, and continue processing the remaining Git_Bundles.
7. WHEN all Git_Bundles in the Transfer_Bundle have been processed AND at least one Git_Bundle was skipped or failed, THE Importer SHALL report the git import operation as succeeded with skipped or failed items.

### Requirement 4: Import Packages to Destination Artifactory (V1 and V2)

**User Story:** As a release engineer, I want the packed npm and Python package versions uploaded to our air-gapped Artifactory, so that builds inside the network can resolve dependencies.

#### Acceptance Criteria

1. WHEN the Importer processes a verified Transfer_Bundle, THE Importer SHALL upload each included Package_Version to the Destination_Artifactory, allowing up to 300 seconds per Package_Version upload.
2. WHEN uploading a Package_Version, THE Importer SHALL upload that Package_Version to the Destination_Artifactory repository that corresponds to the Package_Ecosystem of that Package_Version.
3. WHEN a Package_Version whose Package_Coordinates, version, and Package_Ecosystem match an artifact already present on the Destination_Artifactory is encountered, THE Importer SHALL skip uploading that Package_Version and record that the Package_Version was already present.
4. WHEN a Package_Version upload completes successfully, THE Importer SHALL record the Package_Coordinates, version, and Package_Ecosystem as imported.
5. IF recording a Package_Version as imported fails after a successful upload, THEN THE Importer SHALL halt package processing immediately, report the affected Package_Coordinates and version and the recording failure, and retain the Package_Versions already recorded as imported.
6. IF uploading a Package_Version fails or exceeds the 300-second per-upload limit after retrying up to 3 attempts, THEN THE Importer SHALL report the affected Package_Coordinates and version and the failure, leave previously imported Package_Versions on the Destination_Artifactory unchanged, and continue uploading the remaining Package_Versions.

### Requirement 5: Report Synchronization Results (V1 and V2)

**User Story:** As a release engineer, I want a clear report of each synchronization run, so that I can confirm what was transferred and diagnose failures.

#### Acceptance Criteria

1. WHEN a packing operation completes, THE Packer SHALL produce a report that includes the Sync_Run identifier and the active delivery version (V1 or V2) and lists, for each Tracked_Project, the target git commit references packed and the Package_Versions packed together with their Package_Ecosystems.
2. WHEN an import operation completes, THE Importer SHALL produce a report that includes the Sync_Run identifier and lists each repository updated, each Package_Version uploaded together with its Package_Ecosystem, and each item skipped as already present.
3. WHERE the Pipeline operates as V2 and a Tracked_Project had no git changes packed, THE Packer SHALL include in the report an explicit indication that no git changes were packed for that Tracked_Project, and WHERE a Tracked_Project had no Package_Versions packed, THE Packer SHALL include an explicit indication that no Package_Versions were packed for that Tracked_Project.
4. IF any item failed during the Sync_Run, THEN THE Pipeline SHALL include, in every report produced during that Sync_Run, the failed item identifier and a failure reason for that item, even when the current operation succeeded.
5. WHEN a Sync_Run completes, THE Pipeline SHALL assign exactly one overall status in the report, where the status is "succeeded fully" when no items were skipped or failed, "succeeded with skipped or failed items" when at least one item was skipped or failed while the operation otherwise completed, and "failed" when the operation could not complete.
6. IF a report cannot be produced after a packing or import operation completes, THEN THE Pipeline SHALL mark the Sync_Run as failed and surface an error indicating that report generation failed.

### Requirement 6: Resumable and Idempotent Imports (V1 and V2)

**User Story:** As a release engineer, I want re-running an import to be safe, so that a partially completed or repeated import does not corrupt the destination.

#### Acceptance Criteria

1. WHEN the same Transfer_Bundle is imported more than once, THE Importer SHALL produce a destination state in which each target repository's refs on the Destination_GitLab match the target commit references recorded in the Bundle_Descriptor and each included Package_Version is present exactly once on the Destination_Artifactory, with no duplicated commits, refs, or Package_Versions.
2. WHEN an import is re-run after a partial failure, THE Importer SHALL determine, for each Git_Bundle and each Package_Version in the Transfer_Bundle, whether it was previously recorded as successfully imported, and SHALL apply only the items not recorded as successfully imported.
3. WHILE an import is applying a Git_Bundle to a repository, THE Importer SHALL update the destination repository refs to the target commit references recorded in the Bundle_Descriptor only after all commits and refs in that Git_Bundle have been applied.
4. WHEN a Transfer_Bundle whose items are all already recorded as successfully imported is imported again, THE Importer SHALL skip every item, record each item as already present, and report the import as succeeded with all items skipped.
5. IF an import is interrupted while applying a Git_Bundle before all of its commits and refs have been applied, THEN THE Importer SHALL leave the destination repository refs at their pre-application state so that no ref points at partially applied history.

## V1 Requirements (Full-Snapshot Packing)

These requirements define the V1 full-snapshot packing behavior. They are self-contained and shippable on their own together with the Common Requirements. V1 performs no change tracking and re-packs the complete asset set on every Sync_Run.

### Requirement 7: Pack Full Git History on Every Run (V1)

**User Story:** As a release engineer shipping V1, I want every run to export the full git history of all tracked repositories, so that the destination receives a complete snapshot without any change-tracking machinery.

#### Acceptance Criteria

1. WHEN packing a Tracked_Project, THE Packer SHALL produce a Git_Bundle containing the full git history of all tracked refs of that Tracked_Project.
2. THE Packer SHALL produce a Git_Bundle for every Tracked_Project on every Sync_Run, regardless of whether the git history has changed since any previous Sync_Run.
3. THE Git_Bundle SHALL include the commit history of the included refs sufficient for the Importer to reconstruct each included ref at its target commit reference from an empty repository.
4. THE Packer SHALL record, in the Bundle_Descriptor, the target commit reference covered by each included Git_Bundle.
5. IF producing a Git_Bundle for a Tracked_Project fails, THEN THE Packer SHALL exclude that project's Git_Bundle from the Transfer_Bundle, report the affected project identifier and the failure, and continue packing the remaining Tracked_Projects.

### Requirement 8: Pack All Package Versions on Every Run (V1)

**User Story:** As a release engineer shipping V1, I want every run to export all package versions and their full transitive dependencies for both npm and Python, so that the destination receives a complete package snapshot without any change-tracking machinery.

#### Acceptance Criteria

1. WHEN packing a Tracked_Project, THE Packer SHALL identify all Package_Versions available on the Source_Artifactory for each configured Package of that Tracked_Project, across both the npm and Python Package_Ecosystems.
2. THE Packer SHALL include in the Transfer_Bundle every identified Package_Version that is successfully retrieved from the Source_Artifactory, regardless of whether that Package_Version was included in any previous Sync_Run.
3. WHEN a packed Package_Version declares dependencies in its Dependency_Metadata, THE Packer SHALL recursively resolve the full transitive dependency tree of that Package_Version using the Dependency_Metadata format appropriate to that Package_Version's Package_Ecosystem and include every direct and transitive dependency Package_Version.
4. THE Packer SHALL record, in the Bundle_Descriptor, the Package_Coordinates, version, and Package_Ecosystem of every Package_Version included in the Transfer_Bundle.
5. WHILE recursively resolving the transitive dependency tree, IF a dependency Package_Version has already been resolved or visited during the current packing run, THEN THE Packer SHALL stop further resolution of that dependency path and SHALL include that dependency Package_Version at most once in the Transfer_Bundle.
6. IF a configured Package_Version cannot be retrieved from the Source_Artifactory, THEN THE Packer SHALL exclude that Package_Version from the Transfer_Bundle, record the affected Package_Coordinates, version, and Package_Ecosystem together with a retrieval-failure indication in the Bundle_Descriptor, and continue packing the remaining Packages.
7. IF a required direct or transitive dependency Package_Version cannot be retrieved from the Source_Artifactory, THEN THE Packer SHALL exclude that dependency Package_Version from the Transfer_Bundle, record the affected Package_Coordinates, version, and Package_Ecosystem together with a retrieval-failure indication in the Bundle_Descriptor, and continue packing the remaining Packages.

## V2 Requirements (Incremental Efficiency)

These requirements layer incremental efficiency on top of V1. When the Pipeline operates as V2, the packing behavior defined in Requirement 7 (V1) and Requirement 8 (V1) is superseded by the incremental packing behavior defined in Requirements 10 and 11 below; the Common Requirements (Requirements 1 through 6) continue to apply unchanged.

### Requirement 9: Maintain Synchronization State (V2)

**User Story:** As a release engineer shipping V2, I want the pipeline to remember what was packed last time, so that each run transfers only new changes.

#### Acceptance Criteria

1. WHEN a Sync_Run completes packing successfully, THE Packer SHALL persist, per Tracked_Project, the last packed git commit reference and the set of Package_Versions packed, such that after persistence either the complete updated Sync_State or the prior Sync_State is readable.
2. WHERE no prior Sync_State exists for a Tracked_Project, THE Packer SHALL treat the project as requiring a full initial pack of all git history and all configured Package_Versions.
3. WHEN a Sync_Run begins, THE Packer SHALL load the existing Sync_State to determine the incremental baseline for each Tracked_Project.
4. IF persisting the Sync_State fails after packing, OR IF packing itself fails, THEN THE Packer SHALL mark the Sync_Run as failed and SHALL retain the prior successfully recorded baseline unchanged for every Tracked_Project.
5. IF the loaded Sync_State references a git commit that no longer exists in the source repository, THEN THE Packer SHALL report the affected Tracked_Project and the referenced commit reference and fall back to a full pack for the affected Tracked_Project.
6. IF the Sync_State for a Tracked_Project exists but cannot be read or parsed, THEN THE Packer SHALL report the affected Tracked_Project and the read failure and fall back to a full pack for the affected Tracked_Project.

### Requirement 10: Pack Incremental Git Changes (V2)

**User Story:** As a release engineer shipping V2, I want only the git changes since the last run to be packed, so that the transfer bundle stays small and packing stays fast.

#### Acceptance Criteria

1. WHEN packing a Tracked_Project that has an existing Sync_State whose last packed commit reference exists in the source repository, THE Packer SHALL produce a Git_Bundle containing exactly the commits reachable from the project's tracked refs that are not reachable from the last packed commit reference, together with those tracked refs.
2. WHERE a Tracked_Project has no prior Sync_State, THE Packer SHALL produce a Git_Bundle containing the full git history of the tracked refs.
3. THE Git_Bundle SHALL include the commit history of the included refs required, in combination with history already imported to the Destination_GitLab for that project, for the Importer to reconstruct each included ref at its target commit reference.
4. WHEN no new commits exist for a Tracked_Project since the last packed commit reference AND no other criterion requires a Git_Bundle, THE Packer SHALL exclude that project's Git_Bundle from the Transfer_Bundle and record that no git changes were packed.
5. THE Packer SHALL record, in the Bundle_Descriptor, the source commit reference and the target commit reference covered by each included Git_Bundle.
6. WHERE a Tracked_Project has no prior Sync_State or requires a full pack, THE Packer SHALL produce a Git_Bundle even when no new commits exist since the last packed commit reference.
7. IF producing a Git_Bundle for a Tracked_Project fails, THEN THE Packer SHALL exclude that project's Git_Bundle from the Transfer_Bundle, report the affected project identifier and the failure, and continue packing the remaining Tracked_Projects.

### Requirement 11: Pack New and Changed Packages (V2)

**User Story:** As a release engineer shipping V2, I want only new package versions and changed dependencies to be packed for both npm and Python, so that I avoid re-transferring packages already present downstream.

#### Acceptance Criteria

1. WHEN packing a Tracked_Project, THE Packer SHALL identify the Package_Versions available on the Source_Artifactory, across both the npm and Python Package_Ecosystems, that are not recorded in the Sync_State as already packed.
2. THE Packer SHALL include in the Transfer_Bundle only the Package_Versions identified as not previously packed AND successfully retrieved from the Source_Artifactory.
3. WHEN a packed Package_Version declares dependencies in its Dependency_Metadata, THE Packer SHALL recursively resolve the full transitive dependency tree of that Package_Version using the Dependency_Metadata format appropriate to that Package_Version's Package_Ecosystem and include any direct or transitive dependency Package_Version that is not recorded in the Sync_State as already packed.
4. WHEN a dependency Package_Version is already recorded in the Sync_State as packed, THE Packer SHALL exclude that dependency Package_Version from the Transfer_Bundle.
5. WHEN a dependency Package_Version is not recorded in the Sync_State as packed, THE Packer SHALL include that dependency Package_Version in the Transfer_Bundle.
6. THE Packer SHALL record, in the Bundle_Descriptor, the Package_Coordinates, version, and Package_Ecosystem of every Package_Version included in the Transfer_Bundle.
7. WHILE recursively resolving the transitive dependency tree, IF a dependency Package_Version has already been resolved or visited during the current packing run, THEN THE Packer SHALL stop further resolution of that dependency path and SHALL include that dependency Package_Version at most once in the Transfer_Bundle.
8. IF a configured Package_Version cannot be retrieved from the Source_Artifactory, THEN THE Packer SHALL exclude that Package_Version from the Transfer_Bundle, record the affected Package_Coordinates, version, and Package_Ecosystem together with a retrieval-failure indication in the Bundle_Descriptor, and continue packing the remaining Packages.
9. IF a required direct or transitive dependency Package_Version cannot be retrieved from the Source_Artifactory, THEN THE Packer SHALL exclude that dependency Package_Version from the Transfer_Bundle, record the affected Package_Coordinates, version, and Package_Ecosystem together with a retrieval-failure indication in the Bundle_Descriptor, and continue packing the remaining Packages.
