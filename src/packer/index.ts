/**
 * Packer — source-side component.
 * Reads a validated Manifest, discovers and retrieves git history and package
 * versions (plus their full transitive dependencies), and produces a single
 * self-contained, integrity-protected Transfer_Bundle.
 *
 * Sub-modules (populated in subsequent tasks):
 *   - ManifestValidator
 *   - PackingStrategy (FullSnapshotStrategy / IncrementalStrategy)
 *   - GitPacker
 *   - DependencyResolver
 *   - BundleWriter + IntegrityService
 *   - ReportBuilder
 */

export { GitPacker } from './git-packer.js';
export type { GitPackResult, GitPackerBaseline } from './git-packer.js';
export { NpmAdapter } from './npm-adapter.js';
export { Packer } from './packer.js';
export type { PackerConfig } from './packer.js';
export { FullSnapshotStrategy } from './packing-strategy.js';
export type { PackingStrategy } from './packing-strategy.js';
export { PythonAdapter } from './python-adapter.js';

