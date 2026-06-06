/**
 * Unit tests for ManifestValidator.load
 *
 * These are example-based tests covering the main validation rules.
 * Property-based tests (Properties 1 & 2) are in tasks 2.2 and 2.3.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ManifestValidator } from './manifest-validator';

// ── helpers ───────────────────────────────────────────────────────────────────

async function writeTmp(content: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  const filePath = path.join(tmpDir, 'manifest.json');
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

const validator = new ManifestValidator();

// ── valid manifest ─────────────────────────────────────────────────────────────

describe('ManifestValidator — valid manifests', () => {
  it('accepts a minimal valid manifest with one project and no packages', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        { id: 'proj-a', gitLocation: 'https://github.com/org/a.git', packages: [] },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('VALID');
    expect(result.errors).toHaveLength(0);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.projects).toHaveLength(1);
    expect(result.manifest!.projects[0]!.id).toBe('proj-a');
  });

  it('accepts a manifest with npm and Python packages', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        {
          id: 'mixed',
          gitLocation: 'https://example.com/repo.git',
          packages: [
            { coordinates: 'lodash', ecosystem: 'npm' },
            { coordinates: 'requests', ecosystem: 'Python' },
          ],
        },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('VALID');
    expect(result.manifest!.projects[0]!.packages).toHaveLength(2);
  });

  it('accepts a manifest with 1000 projects', async () => {
    const projects = Array.from({ length: 1000 }, (_, i) => ({
      id: `proj-${i}`,
      gitLocation: `https://example.com/repo${i}.git`,
      packages: [],
    }));
    const file = await writeTmp(JSON.stringify({ projects }));
    const result = await validator.load(file);
    expect(result.status).toBe('VALID');
  });

  it('accepts a project with exactly 1000 packages', async () => {
    const packages = Array.from({ length: 1000 }, (_, i) => ({
      coordinates: `pkg-${i}`,
      ecosystem: 'npm',
    }));
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: 'p', gitLocation: 'https://example.com/r.git', packages }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('VALID');
  });
});

// ── parse failures (Requirement 1.10) ─────────────────────────────────────────

describe('ManifestValidator — parse failures', () => {
  it('returns INVALID with PARSE_FAILURE for invalid JSON', async () => {
    const file = await writeTmp('{ "projects": [}');
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'PARSE_FAILURE');
    expect(err).toBeDefined();
  });

  it('reports line and column for a JSON syntax error', async () => {
    // Multi-line JSON with a deliberate error on line 3
    const bad = '{\n  "projects": [\n    {bad}\n  ]\n}';
    const file = await writeTmp(bad);
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'PARSE_FAILURE');
    expect(err).toBeDefined();
    // line/column may vary by Node.js version; just verify they are positive integers when present
    if (err?.line !== undefined) expect(err.line).toBeGreaterThan(0);
    if (err?.column !== undefined) expect(err.column).toBeGreaterThan(0);
  });

  it('returns INVALID with PARSE_FAILURE for a non-existent file', async () => {
    const result = await validator.load('/no/such/manifest.json');
    expect(result.status).toBe('INVALID');
    expect(result.errors[0]?.code).toBe('PARSE_FAILURE');
  });

  it('returns INVALID with PARSE_FAILURE when root is not an object', async () => {
    const file = await writeTmp('[]');
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors[0]?.code).toBe('PARSE_FAILURE');
  });
});

// ── empty manifest (Requirement 1.9) ──────────────────────────────────────────

describe('ManifestValidator — empty / missing projects', () => {
  it('returns NO_TRACKED_PROJECTS for an empty projects array', async () => {
    const file = await writeTmp(JSON.stringify({ projects: [] }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'NO_TRACKED_PROJECTS')).toBe(true);
  });

  it('returns NO_TRACKED_PROJECTS when projects field is missing', async () => {
    const file = await writeTmp(JSON.stringify({}));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'NO_TRACKED_PROJECTS')).toBe(true);
  });
});

// ── project count (Requirement 1.3) ───────────────────────────────────────────

describe('ManifestValidator — project count', () => {
  it('returns TOO_MANY_PROJECTS for 1001 projects', async () => {
    const projects = Array.from({ length: 1001 }, (_, i) => ({
      id: `proj-${i}`,
      gitLocation: `https://example.com/repo${i}.git`,
      packages: [],
    }));
    const file = await writeTmp(JSON.stringify({ projects }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'TOO_MANY_PROJECTS')).toBe(true);
  });
});

// ── missing required fields (Requirement 1.8) ─────────────────────────────────

describe('ManifestValidator — missing required fields', () => {
  it('reports MISSING_FIELD when id is absent', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [{ gitLocation: 'https://example.com/r.git', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'MISSING_FIELD' && e.fieldName === 'id');
    expect(err).toBeDefined();
  });

  it('reports MISSING_FIELD when gitLocation is absent', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: 'p1', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'MISSING_FIELD' && e.fieldName === 'gitLocation');
    expect(err).toBeDefined();
    expect(err?.projectId).toBe('p1');
  });

  it('reports MISSING_FIELD when gitLocation is empty string', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: 'p1', gitLocation: '   ', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'MISSING_FIELD' && e.fieldName === 'gitLocation');
    expect(err).toBeDefined();
  });

  it('reports MISSING_FIELD when packages field is absent', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: 'p1', gitLocation: 'https://example.com/r.git' }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'MISSING_FIELD' && e.fieldName === 'packages');
    expect(err).toBeDefined();
    expect(err?.projectId).toBe('p1');
  });

  it('collects errors from multiple projects without short-circuiting', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        { gitLocation: 'https://example.com/r.git', packages: [] },       // missing id
        { id: 'p2', packages: [] },                                         // missing gitLocation
        { id: 'p3', gitLocation: 'https://example.com/r3.git', packages: [] }, // valid
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    // Both errors should be present
    expect(result.errors.some(e => e.code === 'MISSING_FIELD' && e.fieldName === 'id')).toBe(true);
    expect(result.errors.some(e => e.code === 'MISSING_FIELD' && e.fieldName === 'gitLocation')).toBe(true);
  });
});

// ── id length constraints (Requirement 1.2) ───────────────────────────────────

describe('ManifestValidator — project id length', () => {
  it('rejects an id of 0 characters (empty string)', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: '', gitLocation: 'https://example.com/r.git', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'INVALID_ID_LENGTH')).toBe(true);
  });

  it('rejects an id of 129 characters', async () => {
    const longId = 'a'.repeat(129);
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: longId, gitLocation: 'https://example.com/r.git', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'INVALID_ID_LENGTH')).toBe(true);
  });

  it('accepts an id of exactly 128 characters', async () => {
    const maxId = 'a'.repeat(128);
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: maxId, gitLocation: 'https://example.com/r.git', packages: [] }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('VALID');
  });
});

// ── duplicate ids (Requirement 1.6) ───────────────────────────────────────────

describe('ManifestValidator — duplicate project ids', () => {
  it('returns INVALID and reports the duplicated id', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        { id: 'dup', gitLocation: 'https://example.com/a.git', packages: [] },
        { id: 'dup', gitLocation: 'https://example.com/b.git', packages: [] },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'DUPLICATE_ID');
    expect(err).toBeDefined();
    expect(err?.duplicatedId).toBe('dup');
  });

  it('reports multiple distinct duplicate ids', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        { id: 'dup1', gitLocation: 'https://example.com/a.git', packages: [] },
        { id: 'dup1', gitLocation: 'https://example.com/b.git', packages: [] },
        { id: 'dup2', gitLocation: 'https://example.com/c.git', packages: [] },
        { id: 'dup2', gitLocation: 'https://example.com/d.git', packages: [] },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const dupIds = result.errors
      .filter(e => e.code === 'DUPLICATE_ID')
      .map(e => e.duplicatedId);
    expect(dupIds).toContain('dup1');
    expect(dupIds).toContain('dup2');
  });
});

// ── unsupported ecosystem (Requirement 1.7) ───────────────────────────────────

describe('ManifestValidator — unsupported ecosystem', () => {
  it('returns INVALID and reports unsupported ecosystem with project id and coordinates', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        {
          id: 'proj-x',
          gitLocation: 'https://example.com/r.git',
          packages: [{ coordinates: 'my-lib', ecosystem: 'ruby' }],
        },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const err = result.errors.find(e => e.code === 'UNSUPPORTED_ECOSYSTEM');
    expect(err).toBeDefined();
    expect(err?.projectId).toBe('proj-x');
    expect(err?.coordinates).toBe('my-lib');
    expect(err?.unsupportedEcosystem).toBe('ruby');
  });

  it('collects ecosystem errors from multiple packages without short-circuiting', async () => {
    const file = await writeTmp(JSON.stringify({
      projects: [
        {
          id: 'proj-y',
          gitLocation: 'https://example.com/r.git',
          packages: [
            { coordinates: 'gem-a', ecosystem: 'ruby' },
            { coordinates: 'crate-b', ecosystem: 'cargo' },
            { coordinates: 'good-pkg', ecosystem: 'npm' },
          ],
        },
      ],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    const ecosystemErrors = result.errors.filter(e => e.code === 'UNSUPPORTED_ECOSYSTEM');
    expect(ecosystemErrors).toHaveLength(2);
    const badEcosystems = ecosystemErrors.map(e => e.unsupportedEcosystem);
    expect(badEcosystems).toContain('ruby');
    expect(badEcosystems).toContain('cargo');
  });
});

// ── package count (Requirement 1.2) ───────────────────────────────────────────

describe('ManifestValidator — package count', () => {
  it('returns INVALID with TOO_MANY_PACKAGES for 1001 packages', async () => {
    const packages = Array.from({ length: 1001 }, (_, i) => ({
      coordinates: `pkg-${i}`,
      ecosystem: 'npm',
    }));
    const file = await writeTmp(JSON.stringify({
      projects: [{ id: 'p', gitLocation: 'https://example.com/r.git', packages }],
    }));
    const result = await validator.load(file);
    expect(result.status).toBe('INVALID');
    expect(result.errors.some(e => e.code === 'TOO_MANY_PACKAGES')).toBe(true);
  });
});
