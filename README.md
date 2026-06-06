# ✈️ Airlift

<div align="center">

**Sync open source assets across an air gap — safely, verifiably, and repeatably.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Jest](https://img.shields.io/badge/tested%20with-Jest-C21325?logo=jest&logoColor=white)](https://jestjs.io/)
[![fast-check](https://img.shields.io/badge/property%20tests-fast--check-blueviolet)](https://fast-check.dev/)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

</div>

---

Airlift mirrors git repositories and npm/Python packages from an internet-connected source into an isolated, air-gapped destination. Everything is packed into a single SHA-256-protected **Transfer_Bundle**, carried across the gap out-of-band (USB drive, data diode, etc.), then unpacked idempotently on the other side.

## How it works

The pipeline has two sides that never communicate directly:

```
 SOURCE SIDE                          DESTINATION SIDE
 ─────────────────────────────        ──────────────────────────────
 Manifest                             Transfer_Bundle (verified)
   └─ git repos     ──┐                 └─ git bundles ──▶ GitLab
   └─ npm packages  ──┼──▶ Packer ══[ air gap ]══▶ Importer
   └─ Python pkgs   ──┘  (Transfer_Bundle)           └─ packages ──▶ Artifactory
```

**Packer** (source side)
1. Validates a Manifest listing tracked projects, git repos, and package coordinates
2. Runs `git bundle create --all` per project to capture full git history
3. Discovers all npm/Python versions on Source Artifactory and resolves the full transitive dependency graph
4. Serializes everything into a portable JSON bundle with an embedded SHA-256 integrity value

**Importer** (destination side)
1. Recomputes and verifies SHA-256 integrity — any mismatch aborts with **zero writes**
2. Publishes git bundles to a private GitLab with atomic ref updates and rollback on failure
3. Uploads package versions to Destination Artifactory, routed by ecosystem (npm → npm repo, Python → PyPI repo)
4. Consults a per-item import ledger so re-runs skip already-completed work safely

Both sides emit structured reports with per-project detail and a single overall status.

## Delivery versions

| | V1 — Full Snapshot | V2 — Incremental *(planned)* |
|---|---|---|
| Git | Full history every run | Only commits since last run |
| Packages | All versions + transitive deps | Only versions not already present |
| State | None | `SyncState` persisted per project |

V2 is purely additive — the bundle format, integrity, Importer, and reporting are shared and version-agnostic.

## Project structure

```
src/
├── packer/       # Source side: Packer orchestrator, GitPacker, NpmAdapter,
│                 #              PythonAdapter, PackingStrategy
├── importer/     # Destination side: Importer orchestrator, GitImporter,
│                 #                   PackageImporter, ImportLedger
├── shared/       # Both sides: ManifestValidator, BundleWriter/Reader,
│                 #             IntegrityService, DependencyResolver,
│                 #             EcosystemAdapter, ReportBuilder
└── types/        # All core TypeScript types and interfaces

test/             # Integration and end-to-end tests
```

## Getting started

**Prerequisites:** Node.js ≥ 20, `git` in `PATH`

```bash
npm install
npm run build
npm test
```

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run build:watch` | Watch mode |
| `npm test` | Run all tests (serial) |
| `npm run test:coverage` | Tests with coverage report |

## Usage

Airlift is a library, not a CLI. You wire the `Packer` and `Importer` orchestrators in your own script.

### 1. Create a Manifest

The Manifest is a JSON file listing tracked projects, their git repos, and package coordinates:

```json
{
  "projects": [
    {
      "id": "my-project",
      "gitLocation": "https://github.com/org/my-project.git",
      "packages": [
        { "coordinates": "lodash", "ecosystem": "npm" },
        { "coordinates": "requests", "ecosystem": "Python" }
      ]
    }
  ]
}
```

| Field | Description |
|---|---|
| `id` | Unique project identifier (1–128 chars) |
| `gitLocation` | Git remote URL or local path |
| `packages[]` | Optional; 0–1000 package coordinates |
| `packages[].coordinates` | npm package name or PyPI distribution name |
| `packages[].ecosystem` | `"npm"` or `"Python"` |

### 2. Run the Packer (source side)

```typescript
import { Packer } from './packer/packer';
import { FullSnapshotStrategy } from './packer/packing-strategy';
import { NpmAdapter } from './packer/npm-adapter';
import { PythonAdapter } from './packer/python-adapter';

const packer = new Packer();

const report = await packer.run({
  manifestPath: './manifest.json',
  outputBundlePath: './bundle.json',
  syncRunId: 'run-2024-01-15-001',
  adapters: new Map([
    ['npm', new NpmAdapter({ baseUrl: 'https://source.jfrog.io/artifactory', apiKey: '...' })],
    ['Python', new PythonAdapter({ baseUrl: 'https://source.jfrog.io/artifactory', apiKey: '...' })],
  ]),
  strategy: new FullSnapshotStrategy(), // V1
});

console.log(report.overallStatus); // "succeeded fully" | "succeeded with skipped or failed items" | "failed"
```

This produces `bundle.json` — a self-contained Transfer_Bundle ready to carry across the air gap.

### 3. Run the Importer (destination side)

```typescript
import { Importer } from './importer/importer';
import { NpmAdapter } from './packer/npm-adapter';
import { PythonAdapter } from './packer/python-adapter';

const importer = new Importer();

const report = await importer.run({
  bundlePath: './bundle.json',
  syncRunId: 'run-2024-01-15-001',
  deliveryVersion: 'V1',
  gitConfig: {
    baseUrl: 'https://gitlab.internal.example.com',
    token: 'glpat-...',
    namespace: 'mirrored-projects',
    localReposBase: '/var/git/mirrors',
  },
  adapters: new Map([
    ['npm', new NpmAdapter({ baseUrl: 'https://dest.jfrog.io/artifactory', apiKey: '...' })],
    ['Python', new PythonAdapter({ baseUrl: 'https://dest.jfrog.io/artifactory', apiKey: '...' })],
  ]),
});

console.log(report.createdRepositories);  // ["my-project", ...]
console.log(report.uploadedVersions);     // [{ coordinates, version, ecosystem }, ...]
console.log(report.overallStatus);        // "succeeded fully" | ...
```

### Configuration reference

**PackerConfig**

| Field | Type | Description |
|---|---|---|
| `manifestPath` | `string` | Path to Manifest JSON |
| `outputBundlePath` | `string` | Where to write the Transfer_Bundle |
| `syncRunId` | `string` | Unique identifier for this run |
| `adapters` | `Map<Ecosystem, EcosystemAdapter>` | npm + Python adapters for Source Artifactory |
| `strategy` | `PackingStrategy` | `FullSnapshotStrategy` (V1) or `IncrementalStrategy` (V2) |

**ImporterConfig**

| Field | Type | Description |
|---|---|---|
| `bundlePath` | `string` | Path to the Transfer_Bundle |
| `syncRunId` | `string` | Must match the pack run's syncRunId |
| `deliveryVersion` | `"V1"` \| `"V2"` | Delivery version |
| `gitConfig` | `GitLabConfig` | Destination GitLab connection |
| `adapters` | `Map<Ecosystem, EcosystemAdapter>` | npm + Python adapters for Destination Artifactory |

**GitLabConfig**

| Field | Type | Description |
|---|---|---|
| `baseUrl` | `string` | GitLab instance URL |
| `token` | `string` | Personal access token |
| `namespace` | `string` | GitLab group/namespace for mirrored repos |
| `localReposBase` | `string` | Local directory for bare repo mirrors |

**ArtifactoryConfig**

| Field | Type | Description |
|---|---|---|
| `baseUrl` | `string` | Artifactory instance URL |
| `apiKey` | `string` | API key (preferred) |
| `username` | `string` | Basic auth username (fallback) |
| `password` | `string` | Basic auth password (fallback) |

## Testing

Unit and property-based tests live alongside source files (`src/**/*.test.ts`). Integration and e2e tests live in `test/`.

Property tests use [fast-check](https://fast-check.dev/) with ≥ 100 iterations and are tagged for traceability:

```typescript
// Feature: airgap-package-sync-pipeline, Property N: <description>
fc.assert(fc.property(...), { numRuns: 100 });
```

19 correctness properties cover manifest validation, bundle integrity, transitive dependency resolution, idempotent imports, atomic git ref updates, and report classification. See [`test/README.md`](test/README.md) for conventions.

## Spec

Full requirements, design, and implementation tasks: [`.kiro/specs/airgap-package-sync-pipeline/`](.kiro/specs/airgap-package-sync-pipeline/)
