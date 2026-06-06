/**
 * BundleReader — loads a Transfer_Bundle from disk and verifies its integrity
 * before exposing any content.
 *
 * On-disk format (single JSON file):
 * {
 *   "descriptor": { ...BundleDescriptor fields... },
 *   "gitBundles": [
 *     { "projectId": "...", "bundleFile": "<base64>", "sourceCommit": "optional", "targetCommits": {...} }
 *   ],
 *   "packages": [
 *     { "ref": {"coordinates": "...", "version": "...", "ecosystem": "npm|Python"}, "fileBytes": "<base64>" }
 *   ]
 * }
 *
 * Rejection rules (Requirements 2.4, 2.5, 2.6):
 *  - File absent or unreadable  → descriptor_absent
 *  - File not valid JSON        → descriptor_unparseable
 *  - parsed.descriptor missing  → descriptor_absent
 *  - descriptor unparseable     → descriptor_unparseable
 *  - integrityValue absent/empty → integrity_value_missing
 *  - recomputed ≠ recorded hash → integrity_mismatch (with bundleId)
 *  - on ANY rejection: expose NO content
 *
 * Requirements: 2.4, 2.5, 2.6
 */

import { readFile } from 'fs/promises';
import type { BundleDescriptor, GitBundleArtifact, PackageArtifact, TransferBundle } from '../types/index.js';
import type { BundleContents } from './integrity-service.js';
import { IntegrityService } from './integrity-service.js';

// ---------------------------------------------------------------------------
// Rejection types
// ---------------------------------------------------------------------------

export type RejectReason =
  | { kind: 'descriptor_absent' }
  | { kind: 'descriptor_unparseable'; details: string }
  | { kind: 'integrity_value_missing' }
  | { kind: 'integrity_mismatch'; bundleId: string };

export type LoadedBundle = { bundle: TransferBundle };
export type BundleLoadResult = LoadedBundle | { reject: RejectReason };

// ---------------------------------------------------------------------------
// On-disk shapes (with base64-encoded binary fields)
// ---------------------------------------------------------------------------

interface OnDiskGitBundle {
  projectId: string;
  bundleFile: string; // base64
  sourceCommit?: string;
  targetCommits: Record<string, string>;
}

interface OnDiskPackage {
  ref: {
    coordinates: string;
    version: string;
    ecosystem: string;
  };
  fileBytes: string; // base64
}

interface OnDiskBundle {
  descriptor?: unknown;
  gitBundles?: unknown[];
  packages?: unknown[];
}

// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------

function isOnDiskGitBundle(v: unknown): v is OnDiskGitBundle {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['projectId'] === 'string' &&
    typeof obj['bundleFile'] === 'string' &&
    (obj['sourceCommit'] === undefined || typeof obj['sourceCommit'] === 'string') &&
    obj['targetCommits'] !== null &&
    typeof obj['targetCommits'] === 'object' &&
    !Array.isArray(obj['targetCommits'])
  );
}

function isOnDiskPackage(v: unknown): v is OnDiskPackage {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  const ref = obj['ref'];
  if (ref === null || typeof ref !== 'object') return false;
  const refObj = ref as Record<string, unknown>;
  return (
    typeof refObj['coordinates'] === 'string' &&
    typeof refObj['version'] === 'string' &&
    typeof refObj['ecosystem'] === 'string' &&
    typeof obj['fileBytes'] === 'string'
  );
}

function isBundleDescriptor(v: unknown): v is BundleDescriptor {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['bundleId'] === 'string' &&
    typeof obj['deliveryVersion'] === 'string' &&
    typeof obj['syncRunId'] === 'string' &&
    Array.isArray(obj['projectCheckpoints']) &&
    typeof obj['integrityAlgorithm'] === 'string'
    // integrityValue may be absent/empty — we check it explicitly later
  );
}

// ---------------------------------------------------------------------------
// BundleReader
// ---------------------------------------------------------------------------

export class BundleReader {
  constructor(private readonly integrityService: IntegrityService) {}

  /**
   * Load a Transfer_Bundle from `filePath`, recompute its integrity over the
   * loaded contents, and return the bundle only when everything checks out.
   *
   * On ANY rejection, returns `{ reject: RejectReason }` and exposes no content.
   */
  async read(filePath: string): Promise<BundleLoadResult> {
    // --- 1. Read and JSON-parse the file ---
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (err) {
      return { reject: { kind: 'descriptor_absent' } };
    }

    let parsed: OnDiskBundle;
    try {
      const value = JSON.parse(raw) as unknown;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return {
          reject: {
            kind: 'descriptor_unparseable',
            details: 'Root JSON value is not an object',
          },
        };
      }
      parsed = value as OnDiskBundle;
    } catch (err) {
      return {
        reject: {
          kind: 'descriptor_unparseable',
          details: err instanceof Error ? err.message : String(err),
        },
      };
    }

    // --- 2. Extract and validate the descriptor ---
    if (parsed.descriptor === undefined || parsed.descriptor === null) {
      return { reject: { kind: 'descriptor_absent' } };
    }

    if (!isBundleDescriptor(parsed.descriptor)) {
      return {
        reject: {
          kind: 'descriptor_unparseable',
          details: 'descriptor field is missing required properties',
        },
      };
    }

    const descriptor: BundleDescriptor = parsed.descriptor;

    // --- 3. Check that integrityValue is present and non-empty ---
    if (!descriptor.integrityValue || descriptor.integrityValue.trim() === '') {
      return { reject: { kind: 'integrity_value_missing' } };
    }

    // --- 4. Deserialize git bundles from base64 ---
    const rawGitBundles: unknown[] = Array.isArray(parsed.gitBundles) ? parsed.gitBundles : [];
    const gitBundles: GitBundleArtifact[] = [];

    for (const item of rawGitBundles) {
      if (!isOnDiskGitBundle(item)) {
        return {
          reject: {
            kind: 'descriptor_unparseable',
            details: 'gitBundles array contains an invalid entry',
          },
        };
      }
      const artifact: GitBundleArtifact = {
        projectId: item.projectId,
        bundleFile: Buffer.from(item.bundleFile, 'base64'),
        targetCommits: item.targetCommits as Record<string, string>,
      };
      if (item.sourceCommit !== undefined) {
        artifact.sourceCommit = item.sourceCommit;
      }
      gitBundles.push(artifact);
    }

    // --- 5. Deserialize packages from base64 ---
    const rawPackages: unknown[] = Array.isArray(parsed.packages) ? parsed.packages : [];
    const packages: PackageArtifact[] = [];

    for (const item of rawPackages) {
      if (!isOnDiskPackage(item)) {
        return {
          reject: {
            kind: 'descriptor_unparseable',
            details: 'packages array contains an invalid entry',
          },
        };
      }
      packages.push({
        ref: {
          coordinates: item.ref.coordinates,
          version: item.ref.version,
          ecosystem: item.ref.ecosystem as 'npm' | 'Python',
        },
        fileBytes: Buffer.from(item.fileBytes, 'base64'),
      });
    }

    // --- 6. Rebuild BundleContents (descriptor meta excludes integrityValue) ---
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { integrityValue, integrityAlgorithm, ...descriptorMeta } = descriptor;

    const contents: BundleContents = {
      gitBundles,
      packages,
      descriptorMeta,
    };

    // --- 7. Verify integrity ---
    const valid = this.integrityService.verify(contents, integrityValue);
    if (!valid) {
      return {
        reject: {
          kind: 'integrity_mismatch',
          bundleId: descriptor.bundleId,
        },
      };
    }

    // --- 8. Success: return the fully hydrated TransferBundle ---
    const bundle: TransferBundle = {
      gitBundles,
      packages,
      descriptor,
    };

    return { bundle };
  }
}
