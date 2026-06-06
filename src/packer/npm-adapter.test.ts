/**
 * Unit tests for NpmAdapter.
 *
 * HTTP calls are intercepted via the injected HttpRequester dependency so no
 * real network connections are opened. The tests cover:
 *   1. discoverVersions — AQL response parsing → PackageRef[]
 *   2. parseDependencies — extract package.json from a minimal .tgz tarball
 *   3. download — request construction and buffer return
 *   4. upload — 201 → uploaded, 409 → already_present, 5xx → failed
 *
 * Requirements: 4.2, 8.1, 8.3
 */

import * as zlib from 'zlib';
import type { ArtifactoryConfig } from '../shared/ecosystem-adapter';
import type { HttpRequestOptions, HttpResponse } from './npm-adapter';
import { extractVersionFromArtifactName, NpmAdapter, tgzBaseName } from './npm-adapter';

// ---------------------------------------------------------------------------
// Mock HTTP requester factory
// ---------------------------------------------------------------------------

interface CapturedRequest {
  options: HttpRequestOptions;
}

/**
 * Create a mock HttpRequester that records calls and returns canned responses.
 */
function makeMockRequester(
  handler: (options: HttpRequestOptions, call: number) => HttpResponse | Promise<HttpResponse>,
): { requester: (opts: HttpRequestOptions) => Promise<HttpResponse>; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  return {
    requester: async (options: HttpRequestOptions) => {
      const callIndex = calls.length;
      calls.push({ options });
      return handler(options, callIndex);
    },
    calls,
  };
}

/** Shorthand: always return the same canned response. */
function staticMock(response: HttpResponse) {
  return makeMockRequester(() => response);
}

// ---------------------------------------------------------------------------
// Tarball builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal POSIX tar header block (512 bytes) for a regular file.
 */
function buildTarHeader(name: string, size: number): Buffer {
  const block = Buffer.alloc(512, 0);

  // name: bytes 0–99
  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(block, 0, 0, Math.min(nameBytes.length, 100));

  // mode: bytes 100–107 (octal)
  Buffer.from('0000644\0').copy(block, 100);

  // uid/gid: bytes 108–123
  Buffer.from('0000000\0').copy(block, 108);
  Buffer.from('0000000\0').copy(block, 116);

  // size: bytes 124–135 (octal, space-padded with trailing space per POSIX)
  const sizeOctal = size.toString(8).padStart(11, '0') + ' ';
  Buffer.from(sizeOctal).copy(block, 124);

  // mtime: bytes 136–147
  Buffer.from('00000000000 ').copy(block, 136);

  // type flag: byte 156 — '0' = regular file
  block[156] = 0x30;

  // ustar magic: bytes 257–264
  Buffer.from('ustar  \0').copy(block, 257);

  // Compute checksum (bytes 148–155): fill with spaces first, then sum all bytes
  Buffer.from('        ').copy(block, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += block[i] ?? 0;
  }
  const checksumOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  Buffer.from(checksumOctal).copy(block, 148);

  return block;
}

/**
 * Build a .tgz archive containing a single file at `filePath` with the given content.
 */
function buildTgzWithFile(filePath: string, content: string): Buffer {
  const contentBytes = Buffer.from(content, 'utf8');
  const header = buildTarHeader(filePath, contentBytes.length);

  // Pad content to 512-byte boundary
  const paddedSize = Math.ceil(Math.max(contentBytes.length, 1) / 512) * 512;
  const paddedContent = Buffer.alloc(paddedSize, 0);
  contentBytes.copy(paddedContent);

  // Two 512-byte end-of-archive zero blocks
  const eoa = Buffer.alloc(1024, 0);

  const tar = Buffer.concat([header, paddedContent, eoa]);
  return zlib.gzipSync(tar);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const srcConfig: ArtifactoryConfig = {
  baseUrl: 'https://src.example.com/artifactory',
  apiKey: 'src-api-key',
};
const destConfig: ArtifactoryConfig = {
  baseUrl: 'https://dest.example.com/artifactory',
  username: 'user',
  password: 'pass',
};

function okResponse(body: string | Buffer): HttpResponse {
  return {
    statusCode: 200,
    headers: {},
    body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
  };
}

function makeAdapter(
  httpRequester?: (opts: HttpRequestOptions) => Promise<HttpResponse>,
): NpmAdapter {
  return new NpmAdapter(srcConfig, 'npm-remote', destConfig, 'npm-local', httpRequester);
}

// ---------------------------------------------------------------------------
// Helper unit tests — tgzBaseName, extractVersionFromArtifactName
// ---------------------------------------------------------------------------

describe('tgzBaseName', () => {
  it('returns the package name unchanged for unscoped packages', () => {
    expect(tgzBaseName('lodash')).toBe('lodash');
    expect(tgzBaseName('express')).toBe('express');
  });

  it('converts @scope/name to scope-name', () => {
    expect(tgzBaseName('@babel/core')).toBe('babel-core');
    expect(tgzBaseName('@types/node')).toBe('types-node');
  });
});

describe('extractVersionFromArtifactName', () => {
  it('extracts version from <basename>-<version>.tgz', () => {
    expect(extractVersionFromArtifactName('lodash-4.17.21.tgz', 'lodash')).toBe('4.17.21');
    expect(extractVersionFromArtifactName('lodash-4.17.20.tgz', 'lodash')).toBe('4.17.20');
  });

  it('returns null for non-matching filenames', () => {
    expect(extractVersionFromArtifactName('other-4.17.21.tgz', 'lodash')).toBeNull();
    expect(extractVersionFromArtifactName('lodash-4.17.21.tar.gz', 'lodash')).toBeNull();
    expect(extractVersionFromArtifactName('lodash-.tgz', 'lodash')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1. discoverVersions
// ---------------------------------------------------------------------------

describe('NpmAdapter.discoverVersions', () => {
  it('returns PackageRefs for each .tgz found via AQL', async () => {
    const aqlResponse = JSON.stringify({
      results: [
        { name: 'lodash-4.17.21.tgz', path: 'lodash/4.17.21', repo: 'npm-remote' },
        { name: 'lodash-4.17.20.tgz', path: 'lodash/4.17.20', repo: 'npm-remote' },
      ],
    });

    const { requester, calls } = staticMock(okResponse(aqlResponse));
    const refs = await makeAdapter(requester).discoverVersions('lodash');

    expect(refs).toHaveLength(2);
    expect(refs).toContainEqual({ coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' });
    expect(refs).toContainEqual({ coordinates: 'lodash', version: '4.17.20', ecosystem: 'npm' });

    // Should have POST'd to the AQL endpoint
    expect(calls[0]?.options.method).toBe('POST');
    expect(calls[0]?.options.path).toContain('/api/search/aql');
    expect(calls[0]?.options.hostname).toBe('src.example.com');

    // Should have sent the AQL query in the body
    const body = calls[0]?.options.body?.toString('utf8') ?? '';
    expect(body).toContain('lodash');
    expect(body).toContain('*.tgz');
  });

  it('deduplicates versions when the same artifact name appears multiple times', async () => {
    const aqlResponse = JSON.stringify({
      results: [
        { name: 'lodash-4.17.21.tgz', path: 'lodash/4.17.21', repo: 'npm-remote' },
        { name: 'lodash-4.17.21.tgz', path: 'lodash/.cache/4.17.21', repo: 'npm-remote' },
      ],
    });

    const { requester } = staticMock(okResponse(aqlResponse));
    const refs = await makeAdapter(requester).discoverVersions('lodash');
    expect(refs).toHaveLength(1);
    expect(refs[0]?.version).toBe('4.17.21');
  });

  it('returns empty array when AQL results are empty', async () => {
    const { requester } = staticMock(okResponse(JSON.stringify({ results: [] })));
    const refs = await makeAdapter(requester).discoverVersions('nonexistent-pkg');
    expect(refs).toHaveLength(0);
  });

  it('throws on non-200 AQL response', async () => {
    const { requester } = staticMock({
      statusCode: 401,
      headers: {},
      body: Buffer.from('Unauthorized'),
    });
    await expect(makeAdapter(requester).discoverVersions('lodash')).rejects.toThrow(
      'AQL search failed',
    );
  });

  it('handles scoped packages (@scope/name) — strips @ and uses scope-name as basename', async () => {
    const aqlResponse = JSON.stringify({
      results: [
        { name: 'babel-core-7.0.0.tgz', path: '@babel/core/7.0.0', repo: 'npm-remote' },
      ],
    });

    const { requester } = staticMock(okResponse(aqlResponse));
    const refs = await makeAdapter(requester).discoverVersions('@babel/core');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ coordinates: '@babel/core', version: '7.0.0', ecosystem: 'npm' });
  });

  it('includes Authorization header using apiKey', async () => {
    const { requester, calls } = staticMock(
      okResponse(JSON.stringify({ results: [] })),
    );
    await makeAdapter(requester).discoverVersions('lodash');
    expect(calls[0]?.options.headers['Authorization']).toBe('Bearer src-api-key');
  });
});

// ---------------------------------------------------------------------------
// 2. parseDependencies
// ---------------------------------------------------------------------------

describe('NpmAdapter.parseDependencies', () => {
  it('parses dependencies, optionalDependencies, and peerDependencies from package.json', async () => {
    const pkgJson = JSON.stringify({
      name: 'my-lib',
      version: '1.0.0',
      dependencies: { lodash: '^4.17.0', axios: '^1.0.0' },
      optionalDependencies: { fsevents: '^2.3.0' },
      peerDependencies: { react: '>=17.0.0' },
    });

    const tgz = buildTgzWithFile('package/package.json', pkgJson);
    const refs = await makeAdapter().parseDependencies(tgz);

    expect(refs).toHaveLength(4);
    const coords = refs.map((r) => r.coordinates);
    expect(coords).toContain('lodash');
    expect(coords).toContain('axios');
    expect(coords).toContain('fsevents');
    expect(coords).toContain('react');

    // All should have ecosystem 'npm'
    for (const ref of refs) {
      expect(ref.ecosystem).toBe('npm');
    }

    // Version is the semver range string as-is
    const lodash = refs.find((r) => r.coordinates === 'lodash');
    expect(lodash?.version).toBe('^4.17.0');
  });

  it('returns empty array when package.json has no dep fields', async () => {
    const pkgJson = JSON.stringify({ name: 'minimal', version: '1.0.0' });
    const tgz = buildTgzWithFile('package/package.json', pkgJson);
    const refs = await makeAdapter().parseDependencies(tgz);
    expect(refs).toHaveLength(0);
  });

  it('deduplicates by coordinates: first occurrence wins when same name appears in multiple fields', async () => {
    const pkgJson = JSON.stringify({
      name: 'my-lib',
      version: '1.0.0',
      dependencies: { react: '^18.0.0' },
      peerDependencies: { react: '>=17.0.0' },
    });
    const tgz = buildTgzWithFile('package/package.json', pkgJson);
    const refs = await makeAdapter().parseDependencies(tgz);
    // dependencies has higher priority → '^18.0.0'
    expect(refs).toHaveLength(1);
    expect(refs[0]?.coordinates).toBe('react');
    expect(refs[0]?.version).toBe('^18.0.0');
  });

  it('returns empty array when no package.json is present in the tarball', async () => {
    const tgz = buildTgzWithFile('package/README.md', 'hello');
    const refs = await makeAdapter().parseDependencies(tgz);
    expect(refs).toHaveLength(0);
  });

  it('falls back to package.json (without package/ prefix) if needed', async () => {
    const pkgJson = JSON.stringify({
      name: 'bare',
      version: '0.1.0',
      dependencies: { chalk: '^5.0.0' },
    });
    const tgz = buildTgzWithFile('package.json', pkgJson);
    const refs = await makeAdapter().parseDependencies(tgz);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.coordinates).toBe('chalk');
  });
});

// ---------------------------------------------------------------------------
// 3. download
// ---------------------------------------------------------------------------

describe('NpmAdapter.download', () => {
  it('GETs the correct URL and returns the response body as a Buffer', async () => {
    const fakeBytes = Buffer.from('fake-tgz-content');
    const { requester, calls } = staticMock(okResponse(fakeBytes));

    const ref = { coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' as const };
    const result = await makeAdapter(requester).download(ref);

    expect(result).toEqual(fakeBytes);
    expect(calls[0]?.options.method).toBe('GET');
    expect(calls[0]?.options.path).toContain('lodash/-/lodash-4.17.21.tgz');
    expect(calls[0]?.options.hostname).toBe('src.example.com');
  });

  it('constructs the correct URL for a scoped package', async () => {
    const { requester, calls } = staticMock(okResponse(Buffer.from('scoped-tgz')));

    const ref = { coordinates: '@babel/core', version: '7.0.0', ecosystem: 'npm' as const };
    await makeAdapter(requester).download(ref);

    const path = calls[0]?.options.path ?? '';
    expect(path).toContain('@babel/core');
    expect(path).toContain('babel-core-7.0.0.tgz');
  });

  it('throws on non-200 response', async () => {
    const { requester } = staticMock({ statusCode: 404, headers: {}, body: Buffer.from('Not Found') });

    const ref = { coordinates: 'missing', version: '1.0.0', ecosystem: 'npm' as const };
    await expect(makeAdapter(requester).download(ref)).rejects.toThrow('Download failed');
  });

  it('uses Authorization header from apiKey', async () => {
    const { requester, calls } = staticMock(okResponse(Buffer.alloc(0)));
    await makeAdapter(requester).download({ coordinates: 'lodash', version: '4.0.0', ecosystem: 'npm' });
    expect(calls[0]?.options.headers['Authorization']).toBe('Bearer src-api-key');
  });

  it('uses the source repo key in the URL path', async () => {
    const { requester, calls } = staticMock(okResponse(Buffer.from('bytes')));
    await makeAdapter(requester).download({ coordinates: 'express', version: '4.18.0', ecosystem: 'npm' });
    expect(calls[0]?.options.path).toContain('/npm-remote/');
  });
});

// ---------------------------------------------------------------------------
// 4. upload
// ---------------------------------------------------------------------------

describe('NpmAdapter.upload', () => {
  const ref = { coordinates: 'lodash', version: '4.17.21', ecosystem: 'npm' as const };
  const fakeBytes = Buffer.from('tgz-data');

  it('returns { kind: "uploaded" } on HTTP 201', async () => {
    const { requester } = staticMock({ statusCode: 201, headers: {}, body: Buffer.alloc(0) });
    const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
    expect(outcome).toEqual({ kind: 'uploaded' });
  });

  it('returns { kind: "already_present" } on HTTP 409', async () => {
    const { requester } = staticMock({ statusCode: 409, headers: {}, body: Buffer.from('Conflict') });
    const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
    expect(outcome).toEqual({ kind: 'already_present' });
  });

  it('returns { kind: "failed", reason } on 5xx errors', async () => {
    const { requester } = staticMock({
      statusCode: 500,
      headers: {},
      body: Buffer.from('Internal Server Error'),
    });
    const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('500');
    }
  });

  it('returns { kind: "failed", reason } when the requester throws', async () => {
    const throwingRequester = async (_opts: HttpRequestOptions): Promise<HttpResponse> => {
      throw new Error('ECONNREFUSED connection refused');
    };
    const outcome = await makeAdapter(throwingRequester).upload(ref, fakeBytes);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('ECONNREFUSED');
    }
  });

  it('PUTs to the correct destination URL', async () => {
    const { requester, calls } = staticMock({ statusCode: 201, headers: {}, body: Buffer.alloc(0) });
    await makeAdapter(requester).upload(ref, fakeBytes);
    expect(calls[0]?.options.method).toBe('PUT');
    expect(calls[0]?.options.path).toContain('lodash/-/lodash-4.17.21.tgz');
    expect(calls[0]?.options.hostname).toBe('dest.example.com');
  });

  it('uses Basic auth header for username/password config', async () => {
    const { requester, calls } = staticMock({ statusCode: 201, headers: {}, body: Buffer.alloc(0) });
    await makeAdapter(requester).upload(ref, fakeBytes);
    const expectedBasic = `Basic ${Buffer.from('user:pass').toString('base64')}`;
    expect(calls[0]?.options.headers['Authorization']).toBe(expectedBasic);
  });

  it('sends the file bytes as the request body', async () => {
    const content = Buffer.from('my-package-bytes-123');
    const { requester, calls } = staticMock({ statusCode: 201, headers: {}, body: Buffer.alloc(0) });
    await makeAdapter(requester).upload(ref, content);
    expect(calls[0]?.options.body).toEqual(content);
  });

  it('uses the destination repo key in the URL path', async () => {
    const { requester, calls } = staticMock({ statusCode: 201, headers: {}, body: Buffer.alloc(0) });
    await makeAdapter(requester).upload(ref, fakeBytes);
    expect(calls[0]?.options.path).toContain('/npm-local/');
  });
});

// ---------------------------------------------------------------------------
// 5. Static properties
// ---------------------------------------------------------------------------

describe('NpmAdapter static properties', () => {
  it('has ecosystem = "npm"', () => {
    expect(makeAdapter().ecosystem).toBe('npm');
  });

  it('has targetRepositoryKind = "npm"', () => {
    expect(makeAdapter().targetRepositoryKind).toBe('npm');
  });
});
