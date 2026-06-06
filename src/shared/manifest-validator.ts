/**
 * ManifestValidator — loads and validates a Manifest JSON file.
 *
 * Implements all structural and semantic validation rules defined in
 * Requirements 1.1–1.10. All errors are collected (non-short-circuiting)
 * before the final result is returned.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
 */

import * as fs from 'fs/promises';
import {
    Manifest,
    ManifestLoadResult,
    TrackedProject,
    ValidationError,
} from '../types/index';

/** Valid package ecosystems per Requirement 1.4. */
const VALID_ECOSYSTEMS = new Set<string>(['npm', 'Python']);

/** Maximum number of projects in a Manifest (Requirement 1.3). */
const MAX_PROJECTS = 1000;

/** Minimum/maximum length of a project id in characters (Requirement 1.2). */
const MIN_ID_LENGTH = 1;
const MAX_ID_LENGTH = 128;

/** Maximum number of package coordinates per project (Requirement 1.2). */
const MAX_PACKAGES = 1000;

/**
 * Attempt to extract line and column numbers from a JSON SyntaxError message.
 *
 * Node.js formats SyntaxError messages like:
 *   "Unexpected token } in JSON at position 42"           (older Node)
 *   "Expected ',' or '}' after property value in JSON at line 3 column 5" (newer Node)
 *
 * When no line/column can be found we fall back to position-based estimation
 * using the raw JSON string.
 */
function parseErrorLineCol(
  err: SyntaxError,
  rawJson: string,
): { line?: number; column?: number } {
  // Newer Node.js (v20+) includes "line N column M" in the message
  const lineColMatch = err.message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColMatch) {
    const lineStr = lineColMatch[1];
    const colStr = lineColMatch[2];
    if (lineStr !== undefined && colStr !== undefined) {
      return { line: parseInt(lineStr, 10), column: parseInt(colStr, 10) };
    }
  }

  // Older Node.js includes "at position N"
  const posMatch = err.message.match(/at position\s+(\d+)/i);
  if (posMatch) {
    const posStr = posMatch[1];
    if (posStr !== undefined) {
      const pos = parseInt(posStr, 10);
      return positionToLineCol(rawJson, pos);
    }
  }

  return {};
}

/** Convert a zero-based character offset in a string to 1-based line/column. */
function positionToLineCol(text: string, pos: number): { line: number; column: number } {
  const before = text.slice(0, pos);
  const lines = before.split('\n');
  const line = lines.length;
  const column = (lines[lines.length - 1]?.length ?? 0) + 1;
  return { line, column };
}

/**
 * Push a ValidationError only including optional fields that have real values.
 * This is needed because the tsconfig enables exactOptionalPropertyTypes.
 */
function pushError(errors: ValidationError[], base: ValidationError): void {
  // Build a clean object containing only defined optional fields
  const err: ValidationError = { code: base.code, message: base.message };
  if (base.projectId !== undefined) err.projectId = base.projectId;
  if (base.fieldName !== undefined) err.fieldName = base.fieldName;
  if (base.duplicatedId !== undefined) err.duplicatedId = base.duplicatedId;
  if (base.unsupportedEcosystem !== undefined) err.unsupportedEcosystem = base.unsupportedEcosystem;
  if (base.coordinates !== undefined) err.coordinates = base.coordinates;
  if (base.line !== undefined) err.line = base.line;
  if (base.column !== undefined) err.column = base.column;
  errors.push(err);
}

/**
 * Validates a single raw project object.  Returns any per-project errors.
 * The `index` parameter is only used for error messages when `id` is absent.
 */
function validateProject(
  raw: unknown,
  index: number,
  seenIds: Map<string, number>,
  errors: ValidationError[],
): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project at index ${index} is not a valid object`,
    });
    return;
  }

  const project = raw as Record<string, unknown>;

  // ── id ──────────────────────────────────────────────────────────────────
  const rawId = project['id'];
  const hasId = rawId !== undefined && rawId !== null;
  const id: string | undefined =
    hasId && typeof rawId === 'string' ? rawId : undefined;

  if (!hasId || typeof rawId !== 'string') {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project at index ${index} is missing required field "id"`,
      fieldName: 'id',
    });
  } else if (rawId.length < MIN_ID_LENGTH || rawId.length > MAX_ID_LENGTH) {
    pushError(errors, {
      code: 'INVALID_ID_LENGTH',
      message: `Project id "${rawId}" must be between ${MIN_ID_LENGTH} and ${MAX_ID_LENGTH} characters (got ${rawId.length})`,
      projectId: rawId,
    });
  }

  // ── duplicate id ─────────────────────────────────────────────────────────
  if (id !== undefined) {
    if (seenIds.has(id)) {
      pushError(errors, {
        code: 'DUPLICATE_ID',
        message: `Duplicate project id "${id}" (first seen at index ${seenIds.get(id)})`,
        duplicatedId: id,
        projectId: id,
      });
    } else {
      seenIds.set(id, index);
    }
  }

  // ── gitLocation ──────────────────────────────────────────────────────────
  const rawGitLocation = project['gitLocation'];
  if (rawGitLocation === undefined || rawGitLocation === null) {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} is missing required field "gitLocation"`,
      ...(id !== undefined ? { projectId: id } : {}),
      fieldName: 'gitLocation',
    });
  } else if (typeof rawGitLocation !== 'string' || rawGitLocation.trim() === '') {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} has an empty "gitLocation"`,
      ...(id !== undefined ? { projectId: id } : {}),
      fieldName: 'gitLocation',
    });
  }

  // ── packages ─────────────────────────────────────────────────────────────
  const rawPackages = project['packages'];
  if (rawPackages === undefined || rawPackages === null) {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} is missing required field "packages"`,
      ...(id !== undefined ? { projectId: id } : {}),
      fieldName: 'packages',
    });
    return; // can't validate individual packages without the array
  }

  if (!Array.isArray(rawPackages)) {
    pushError(errors, {
      code: 'MISSING_FIELD',
      message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} field "packages" must be an array`,
      ...(id !== undefined ? { projectId: id } : {}),
      fieldName: 'packages',
    });
    return;
  }

  if (rawPackages.length > MAX_PACKAGES) {
    pushError(errors, {
      code: 'TOO_MANY_PACKAGES',
      message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} has ${rawPackages.length} package coordinates, which exceeds the maximum of ${MAX_PACKAGES}`,
      ...(id !== undefined ? { projectId: id } : {}),
    });
  }

  // ── per-package ecosystem validation ─────────────────────────────────────
  for (let pi = 0; pi < rawPackages.length; pi++) {
    const pkg = rawPackages[pi] as Record<string, unknown> | null | undefined;
    if (pkg === null || pkg === undefined || typeof pkg !== 'object' || Array.isArray(pkg)) {
      continue; // skip non-object entries; structural parse would have caught these
    }

    const ecosystem = pkg['ecosystem'];
    const coordinatesVal = pkg['coordinates'];
    const coordinates: string | undefined =
      typeof coordinatesVal === 'string' ? coordinatesVal : undefined;

    if (
      ecosystem !== undefined &&
      ecosystem !== null &&
      !VALID_ECOSYSTEMS.has(ecosystem as string)
    ) {
      pushError(errors, {
        code: 'UNSUPPORTED_ECOSYSTEM',
        message: `Project${id !== undefined ? ` "${id}"` : ` at index ${index}`} has unsupported ecosystem "${String(ecosystem)}" for package "${coordinates ?? String(pi)}"`,
        ...(id !== undefined ? { projectId: id } : {}),
        ...(coordinates !== undefined ? { coordinates } : {}),
        unsupportedEcosystem: String(ecosystem),
      });
    }
  }
}

/**
 * ManifestValidator loads and validates a Manifest file.
 *
 * Usage:
 *   const result = await new ManifestValidator().load('/path/to/manifest.json');
 */
export class ManifestValidator {
  /**
   * Load and validate the Manifest at `path`.
   *
   * Returns a `ManifestLoadResult` with:
   *   - `status: 'VALID'` and the hydrated `manifest` object on success.
   *   - `status: 'INVALID'` and a non-empty `errors` array on any validation failure.
   *
   * All errors are collected before returning — validation does NOT short-circuit
   * on the first failure.
   *
   * Requirements: 1.1–1.10
   */
  async load(path: string): Promise<ManifestLoadResult> {
    // ── Read the file ────────────────────────────────────────────────────────
    let rawJson: string;
    try {
      rawJson = await fs.readFile(path, 'utf-8');
    } catch (e) {
      const ioErr = e as NodeJS.ErrnoException;
      return {
        status: 'INVALID',
        errors: [
          {
            code: 'PARSE_FAILURE',
            message: `Cannot read manifest file "${path}": ${ioErr.message}`,
          },
        ],
      };
    }

    // ── Parse JSON ───────────────────────────────────────────────────────────
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (e) {
      const syntaxErr = e as SyntaxError;
      const { line, column } = parseErrorLineCol(syntaxErr, rawJson);
      const parseErr: ValidationError = {
        code: 'PARSE_FAILURE',
        message: `JSON parse error in "${path}": ${syntaxErr.message}`,
      };
      if (line !== undefined) parseErr.line = line;
      if (column !== undefined) parseErr.column = column;
      return {
        status: 'INVALID',
        errors: [parseErr],
      };
    }

    // ── Top-level structure ──────────────────────────────────────────────────
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'INVALID',
        errors: [
          {
            code: 'PARSE_FAILURE',
            message: `Manifest root must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
          },
        ],
      };
    }

    const root = parsed as Record<string, unknown>;
    const errors: ValidationError[] = [];

    // ── projects field ───────────────────────────────────────────────────────
    if (!('projects' in root) || root['projects'] === undefined || root['projects'] === null) {
      // No projects field at all → equivalent to empty manifest
      pushError(errors, {
        code: 'NO_TRACKED_PROJECTS',
        message: 'Manifest contains no Tracked_Projects (missing "projects" field)',
      });
      return { status: 'INVALID', errors };
    }

    if (!Array.isArray(root['projects'])) {
      return {
        status: 'INVALID',
        errors: [
          {
            code: 'PARSE_FAILURE',
            message: '"projects" must be an array',
          },
        ],
      };
    }

    const rawProjects: unknown[] = root['projects'];

    // ── Project count ────────────────────────────────────────────────────────
    if (rawProjects.length === 0) {
      pushError(errors, {
        code: 'NO_TRACKED_PROJECTS',
        message: 'Manifest contains no Tracked_Projects',
      });
      // Fall through to collect any other errors
    } else if (rawProjects.length > MAX_PROJECTS) {
      pushError(errors, {
        code: 'TOO_MANY_PROJECTS',
        message: `Manifest contains ${rawProjects.length} projects, which exceeds the maximum of ${MAX_PROJECTS}`,
      });
    }

    // ── Per-project validation ────────────────────────────────────────────────
    const seenIds = new Map<string, number>();
    for (let i = 0; i < rawProjects.length; i++) {
      validateProject(rawProjects[i], i, seenIds, errors);
    }

    // ── Determine result ─────────────────────────────────────────────────────
    if (errors.length > 0) {
      return { status: 'INVALID', errors };
    }

    // All checks passed — build the typed Manifest object.
    const projects: TrackedProject[] = rawProjects.map((raw) => {
      const p = raw as Record<string, unknown>;
      return {
        id: p['id'] as string,
        gitLocation: p['gitLocation'] as string,
        packages: ((p['packages'] as unknown[]) ?? []).map((pkg) => {
          const pkgObj = pkg as Record<string, unknown>;
          return {
            coordinates: pkgObj['coordinates'] as string,
            ecosystem: pkgObj['ecosystem'] as 'npm' | 'Python',
          };
        }),
      };
    });

    const manifest: Manifest = {
      projects,
      status: 'VALID',
    };

    return { status: 'VALID', manifest, errors: [] };
  }
}
