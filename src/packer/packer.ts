/**
 * Packer — V1 orchestrator that wires together ManifestValidator, GitPacker,
 * DependencyResolver, BundleWriter, and ReportBuilder to produce a
 * Transfer_Bundle and a PackReport from a Manifest file.
 *
 * Requirements: 1.5, 2.1, 5.1, 7.2, 8.2
 */

import { BundleWriter } from '../shared/bundle-writer';
import { DependencyResolver } from '../shared/dependency-resolver';
import type { EcosystemAdapter } from '../shared/ecosystem-adapter.js';
import { IntegrityService } from '../shared/integrity-service';
import { ManifestValidator } from '../shared/manifest-validator';
import { ReportBuilder } from '../shared/report-builder';
import type {
    Ecosystem,
    GitBundleArtifact,
    ItemFailure,
    PackReport,
    PackageArtifact,
    ProjectCheckpoint,
    ProjectReport,
} from '../types/index.js';
import { GitPacker } from './git-packer';
import type { PackingStrategy } from './packing-strategy.js';

// ---------------------------------------------------------------------------
// PackerConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for a single Packer run.
 */
export interface PackerConfig {
  /** Absolute or relative path to the Manifest JSON file. */
  manifestPath: string;
  /** Destination file path for the serialized Transfer_Bundle. */
  outputBundlePath: string;
  /** Identifier for this Sync_Run (carried into reports and the bundle descriptor). */
  syncRunId: string;
  /** EcosystemAdapter instances keyed by ecosystem, used by DependencyResolver. */
  adapters: Map<Ecosystem, EcosystemAdapter>;
  /** Packing strategy that determines git baselines and package filters (V1 or V2). */
  strategy: PackingStrategy;
}

// ---------------------------------------------------------------------------
// Packer
// ---------------------------------------------------------------------------

/**
 * Packer orchestrator.
 *
 * Algorithm:
 *   1. Load + validate the Manifest via ManifestValidator.
 *   2. If INVALID → return a failure PackReport carrying validation errors.
 *   3. For each TrackedProject:
 *      a. Determine git baseline via strategy.gitBaseline(project).
 *      b. Pack git via GitPacker.pack(project, baseline).
 *         - Failure → record ItemFailure; continue to next project.
 *         - Success → collect GitBundleArtifact.
 *      c. Determine package filter via strategy.packageFilter(project).
 *      d. Discover root package versions via adapter.discoverVersions() for each coordinate.
 *      e. Resolve full transitive closure via DependencyResolver.resolve(roots, filter).
 *      f. Build ProjectCheckpoint.
 *   4. Write Transfer_Bundle via BundleWriter.write(...) + writeToDisk(...).
 *   5. Build and return a PackReport via ReportBuilder.buildPackReport(...).
 */
export class Packer {
  /**
   * Execute a packing run.
   *
   * @param config  Configuration for this run.
   * @returns       A PackReport describing the outcome.
   */
  async run(config: PackerConfig): Promise<PackReport> {
    // --- 1. Load + validate the Manifest ---
    const validator = new ManifestValidator();
    const loadResult = await validator.load(config.manifestPath);

    // --- 2. Abort with failure report on INVALID manifest ---
    if (loadResult.status === 'INVALID') {
      const failures: ItemFailure[] = loadResult.errors.map((err) => ({
        itemId: err.projectId ?? err.code,
        reason: err.message,
      }));
      // Return a failure report directly — the operation could not complete,
      // so overallStatus must be 'failed' (Requirement 5.5).
      const packReport: PackReport = {
        syncRunId: config.syncRunId,
        deliveryVersion: config.strategy.name,
        bundleId: '',
        perProject: [],
        overallStatus: 'failed',
        failures,
      };
      return packReport;
    }

    // manifest is VALID from here on
    const manifest = loadResult.manifest!;

    // --- 3. Set up shared services ---
    const integrityService = new IntegrityService();
    const bundleWriter = new BundleWriter(integrityService);
    const reportBuilder = new ReportBuilder();
    const gitPacker = new GitPacker();
    const resolver = new DependencyResolver(config.adapters);

    const allGitBundles: GitBundleArtifact[] = [];
    const allPackages: PackageArtifact[] = [];
    const allFailures: ItemFailure[] = [];
    const allCheckpoints: ProjectCheckpoint[] = [];
    const perProjectReports: ProjectReport[] = [];

    // --- 4. Process each TrackedProject ---
    for (const project of manifest.projects) {
      // a. Git baseline from strategy
      const baseline = config.strategy.gitBaseline(project);

      // b. Pack git
      const gitResult = await gitPacker.pack(project, baseline);

      let gitTargetCommits: Record<string, string> = {};

      if (gitResult.ok === true) {
        allGitBundles.push(gitResult.artifact);
        gitTargetCommits = gitResult.artifact.targetCommits;
      } else if (gitResult.ok === false) {
        allFailures.push({
          itemId: gitResult.projectId,
          reason: gitResult.reason,
        });
        // gitTargetCommits stays {} on failure
      }
      // ok === 'skip' (V2 only): no git bundle, no failure

      // c. Package filter from strategy
      const filter = config.strategy.packageFilter(project);

      // d. Discover root versions for each package coordinate
      const roots: Array<{ coordinates: string; version: string; ecosystem: Ecosystem }> = [];
      for (const coord of project.packages) {
        const adapter = config.adapters.get(coord.ecosystem);
        if (adapter === undefined) {
          // No adapter registered for this ecosystem — record failure and skip
          allFailures.push({
            itemId: `${project.id}:${coord.coordinates}`,
            reason: `No adapter registered for ecosystem "${coord.ecosystem}"`,
          });
          continue;
        }
        try {
          const versions = await adapter.discoverVersions(coord.coordinates);
          roots.push(...versions);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          allFailures.push({
            itemId: `${project.id}:${coord.coordinates}`,
            reason: `discoverVersions failed: ${reason}`,
          });
        }
      }

      // e. Resolve full transitive closure
      const resolveResult = await resolver.resolve(roots, filter);

      allPackages.push(...resolveResult.included);

      // f. Build ProjectCheckpoint
      const checkpoint: ProjectCheckpoint = {
        projectId: project.id,
        gitTargetCommits,
        packedVersions: resolveResult.included.map((a) => a.ref),
        retrievalFailures: resolveResult.failures,
      };
      allCheckpoints.push(checkpoint);

      // Record per-project retrieval failures as ItemFailures too
      for (const rf of resolveResult.failures) {
        allFailures.push({
          itemId: `${rf.ref.ecosystem}:${rf.ref.coordinates}@${rf.ref.version}`,
          reason: rf.reason,
        });
      }

      // Per-project report entry
      perProjectReports.push({
        projectId: project.id,
        gitTargetCommits,
        packedVersions: resolveResult.included.map((a) => a.ref),
      });
    }

    // --- 5. Write the Transfer_Bundle ---
    const bundle = bundleWriter.write({
      gitBundles: allGitBundles,
      packages: allPackages,
      projectCheckpoints: allCheckpoints,
      retrievalFailures: allCheckpoints.flatMap((c) => c.retrievalFailures),
      syncRunId: config.syncRunId,
      deliveryVersion: config.strategy.name,
    });

    await bundleWriter.writeToDisk(bundle, config.outputBundlePath);

    // --- 6. Build and return the PackReport ---
    return reportBuilder.buildPackReport({
      syncRunId: config.syncRunId,
      deliveryVersion: config.strategy.name,
      bundleId: bundle.descriptor.bundleId,
      perProject: perProjectReports,
      failures: allFailures,
    });
  }
}
