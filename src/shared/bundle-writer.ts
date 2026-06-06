/**
 * BundleWriter — serializes packing artifacts into a self-contained Transfer_Bundle,
 * computes and embeds the SHA-256 integrity value, and assigns a unique bundle id.
 *
 * Bundle format (on disk — a single JSON file):
 * {
 *   "descriptor": { ...BundleDescriptor },
 *   "gitBundles": [
 *     { "projectId": "...", "bundleFile": "<base64>", "sourceCommit"?: "...", "targetCommits": {...} }
 *   ],
 *   "packages": [
 *     { "ref": {...PackageRef...}, "fileBytes": "<base64>" }
 *   ]
 * }
 *
 * Binary fields (bundleFile, fileBytes) are base64-encoded in the JSON representation
 * so the bundle is a portable, self-contained text file.
 *
 * Requirements: 2.1, 2.2, 2.3, 7.4, 8.4
 */

import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import type {
    BundleDescriptor,
    DeliveryVersion,
    GitBundleArtifact,
    PackageArtifact,
    ProjectCheckpoint,
    RetrievalFailure,
    TransferBundle,
} from '../types/index.js';
import type { BundleContents } from './integrity-service.js';
import { IntegrityService } from './integrity-service.js';

// ---------------------------------------------------------------------------
// WriteInput
// ---------------------------------------------------------------------------

/**
 * All the inputs needed to produce one Transfer_Bundle.
 */
export interface WriteInput {
  /** Raw git bundle artifacts produced by the GitPacker. */
  gitBundles: GitBundleArtifact[];
  /** Package version artifacts produced by the DependencyResolver. */
  packages: PackageArtifact[];
  /**
   * Per-project packing checkpoints recording git target commits and packed
   * package versions for this run (Requirements 7.4, 8.4).
   */
  projectCheckpoints: ProjectCheckpoint[];
  /**
   * Package versions that could not be retrieved, to be recorded in the
   * Bundle_Descriptor (Requirements 8.6, 8.7).
   */
  retrievalFailures: RetrievalFailure[];
  /** Identifier of the Sync_Run that is producing this bundle. */
  syncRunId: string;
  /** Delivery version of the pipeline (V1 or V2). */
  deliveryVersion: DeliveryVersion;
}

// ---------------------------------------------------------------------------
// On-disk bundle format types
// ---------------------------------------------------------------------------

/** On-disk representation of a single git bundle (binary → base64). */
interface SerializedGitBundle {
  projectId: string;
  bundleFile: string; // base64
  sourceCommit?: string;
  targetCommits: Record<string, string>;
}

/** On-disk representation of a single package artifact (binary → base64). */
interface SerializedPackage {
  ref: {
    coordinates: string;
    version: string;
    ecosystem: string;
  };
  fileBytes: string; // base64
}

/** The complete on-disk bundle JSON structure. */
export interface BundleFileFormat {
  descriptor: BundleDescriptor;
  gitBundles: SerializedGitBundle[];
  packages: SerializedPackage[];
}

// ---------------------------------------------------------------------------
// Per-Packer counter for guaranteed uniqueness within a process lifetime
// ---------------------------------------------------------------------------

let _bundleCounter = 0;

/** Reset the internal counter — intended for tests only. */
export function _resetBundleCounter(): void {
  _bundleCounter = 0;
}

// ---------------------------------------------------------------------------
// BundleWriter
// ---------------------------------------------------------------------------

/**
 * Produces a `TransferBundle` from packing artifacts.
 *
 * Responsibilities:
 *   1. Assign a unique bundle id (UUID + monotonic counter, Requirement 2.2).
 *   2. Build the descriptor metadata (without integrity fields).
 *   3. Delegate integrity computation to `IntegrityService` (Requirement 2.3).
 *   4. Embed the integrity value into the final `BundleDescriptor`.
 *   5. Serialise the bundle to disk as JSON with base64-encoded binary fields.
 */
export class BundleWriter {
  constructor(private readonly integrityService: IntegrityService) {}

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  /**
   * Build and return a `TransferBundle` from the supplied packing artifacts.
   *
   * The returned bundle is fully self-contained and integrity-protected —
   * calling `BundleReader.read()` on its serialised form will pass integrity
   * verification on the first try.
   */
  write(input: WriteInput): TransferBundle {
    // --- 1. Generate a unique bundle id (Requirement 2.2) ---
    const counter = ++_bundleCounter;
    const bundleId = `${randomUUID()}-${counter}`;

    // --- 2. Build descriptor metadata (without integrity fields) ---
    const descriptorMeta: Omit<BundleDescriptor, 'integrityValue' | 'integrityAlgorithm'> = {
      bundleId,
      deliveryVersion: input.deliveryVersion,
      syncRunId: input.syncRunId,
      projectCheckpoints: input.projectCheckpoints,
    };

    // --- 3. Compute integrity value over the canonical bundle contents ---
    const contents: BundleContents = {
      gitBundles: input.gitBundles,
      packages: input.packages,
      descriptorMeta,
    };
    const integrityValue = this.integrityService.compute(contents);

    // --- 4. Assemble the full BundleDescriptor with the embedded integrity value ---
    const descriptor: BundleDescriptor = {
      ...descriptorMeta,
      integrityValue,
      integrityAlgorithm: 'SHA-256',
    };

    // --- 5. Return the complete TransferBundle ---
    return {
      gitBundles: input.gitBundles,
      packages: input.packages,
      descriptor,
    };
  }

  // -------------------------------------------------------------------------
  // writeToDisk
  // -------------------------------------------------------------------------

  /**
   * Serialize a `TransferBundle` to disk at `outputPath` as a `.json` file.
   *
   * Binary fields (`bundleFile` and `fileBytes`) are base64-encoded so the
   * file is a portable, self-contained text artifact.
   */
  async writeToDisk(bundle: TransferBundle, outputPath: string): Promise<void> {
    const fileFormat: BundleFileFormat = {
      descriptor: bundle.descriptor,
      gitBundles: bundle.gitBundles.map((gb) => {
        const serialized: SerializedGitBundle = {
          projectId: gb.projectId,
          bundleFile: gb.bundleFile.toString('base64'),
          targetCommits: gb.targetCommits,
        };
        if (gb.sourceCommit !== undefined) {
          serialized.sourceCommit = gb.sourceCommit;
        }
        return serialized;
      }),
      packages: bundle.packages.map((pkg) => ({
        ref: pkg.ref,
        fileBytes: pkg.fileBytes.toString('base64'),
      })),
    };

    await writeFile(outputPath, JSON.stringify(fileFormat, null, 2), 'utf8');
  }
}
