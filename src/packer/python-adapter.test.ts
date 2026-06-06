/**
 * Unit tests for PythonAdapter
 *
 * HTTP calls are mocked via the injected HttpRequester dependency so no real
 * network connections are opened.
 *
 * Tests cover:
 *  - discoverVersions: AQL query, wheel/sdist filename parsing, deduplication
 *  - parseDependencies: wheel METADATA extraction, sdist PKG-INFO extraction,
 *    Requires-Dist parsing (strips markers/extras), unknown format
 *  - download: AQL lookup + file fetch, missing artifact error
 *  - upload: 2xx → uploaded, 409 → already_present, 5xx → failed
 *
 * Requirements: 4.2, 8.1, 8.3
 */

import * as zlib from 'zlib';
import type { ArtifactoryConfig } from '../shared/ecosystem-adapter';
import type { HttpRequestOptions, HttpResponse } from './npm-adapter';
import { PythonAdapter } from './python-adapter';

// ---------------------------------------------------------------------------
// Mock HTTP requester factory (mirrors NpmAdapter test pattern)
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

function okResponse(body: string | Buffer): HttpResponse {
    return {
        statusCode: 200,
        headers: {},
        body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
    };
}

// ---------------------------------------------------------------------------
// AQL response builder
// ---------------------------------------------------------------------------

function makeAqlResponse(items: Array<{ name: string; path: string; repo: string }>): string {
    return JSON.stringify({ results: items });
}

// ---------------------------------------------------------------------------
// Wheel (ZIP) building helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ZIP file in memory containing a single stored (method=0) entry.
 */
function buildMinimalZip(filename: string, content: string): Buffer {
    const filenameBytes = Buffer.from(filename, 'utf8');
    const contentBytes = Buffer.from(content, 'utf8');

    // Local file header (30 bytes + filename + content)
    const LFH = Buffer.alloc(30 + filenameBytes.length + contentBytes.length, 0);
    LFH.writeUInt32LE(0x04034b50, 0);   // signature
    LFH.writeUInt16LE(20, 4);            // version needed
    LFH.writeUInt16LE(0, 6);             // flags
    LFH.writeUInt16LE(0, 8);             // compression: stored
    LFH.writeUInt16LE(0, 10);
    LFH.writeUInt16LE(0, 12);
    LFH.writeUInt32LE(0, 14);            // crc-32
    LFH.writeUInt32LE(contentBytes.length, 18); // compressed size
    LFH.writeUInt32LE(contentBytes.length, 22); // uncompressed size
    LFH.writeUInt16LE(filenameBytes.length, 26);
    LFH.writeUInt16LE(0, 28);
    filenameBytes.copy(LFH, 30);
    contentBytes.copy(LFH, 30 + filenameBytes.length);

    // Central directory header (46 bytes + filename)
    const CDH = Buffer.alloc(46 + filenameBytes.length, 0);
    CDH.writeUInt32LE(0x02014b50, 0);   // signature
    CDH.writeUInt16LE(20, 4);
    CDH.writeUInt16LE(20, 6);
    CDH.writeUInt16LE(0, 8);
    CDH.writeUInt16LE(0, 10);            // compression: stored
    CDH.writeUInt32LE(0, 16);            // crc-32
    CDH.writeUInt32LE(contentBytes.length, 20);
    CDH.writeUInt32LE(contentBytes.length, 24);
    CDH.writeUInt16LE(filenameBytes.length, 28);
    CDH.writeUInt16LE(0, 30);
    CDH.writeUInt16LE(0, 32);
    CDH.writeUInt32LE(0, 42);            // local header offset = 0
    filenameBytes.copy(CDH, 46);

    // End of central directory (22 bytes)
    const EOCD = Buffer.alloc(22, 0);
    EOCD.writeUInt32LE(0x06054b50, 0);
    EOCD.writeUInt16LE(0, 4);
    EOCD.writeUInt16LE(0, 6);
    EOCD.writeUInt16LE(1, 8);            // entries on disk
    EOCD.writeUInt16LE(1, 10);           // total entries
    EOCD.writeUInt32LE(CDH.length, 12); // CD size
    EOCD.writeUInt32LE(LFH.length, 16); // CD offset
    EOCD.writeUInt16LE(0, 20);

    return Buffer.concat([LFH, CDH, EOCD]);
}

// ---------------------------------------------------------------------------
// Sdist (tar.gz) building helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal .tar.gz in memory with a single file at `tarPath`.
 */
function buildMinimalTarGz(tarPath: string, content: string): Buffer {
    const contentBytes = Buffer.from(content, 'utf8');

    // Build 512-byte TAR header
    const header = Buffer.alloc(512, 0);
    // Name (bytes 0–99, NUL-terminated)
    Buffer.from(tarPath, 'utf8').copy(header, 0, 0, Math.min(tarPath.length, 100));
    // Mode (bytes 100–107)
    Buffer.from('0000644\0', 'utf8').copy(header, 100);
    // Size in octal (bytes 124–135, space-terminated)
    Buffer.from(contentBytes.length.toString(8).padStart(11, '0') + ' ', 'utf8').copy(header, 124);
    // Type flag (byte 156): regular file
    header[156] = 0x30;

    // Checksum
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i] ?? 0;
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'utf8').copy(header, 148);

    // File data padded to 512-byte boundary
    const paddedSize = Math.ceil(contentBytes.length / 512) * 512;
    const fileData = Buffer.alloc(paddedSize, 0);
    contentBytes.copy(fileData);

    // Two 512-byte zero blocks = end of archive
    const eoa = Buffer.alloc(1024, 0);

    const tarBuf = Buffer.concat([header, fileData, eoa]);
    return zlib.gzipSync(tarBuf);
}

// ---------------------------------------------------------------------------
// Test config + factory
// ---------------------------------------------------------------------------

const SRC: ArtifactoryConfig = {
    baseUrl: 'https://src.example.com/artifactory',
    apiKey: 'src-api-key',
};
const DST: ArtifactoryConfig = {
    baseUrl: 'https://dst.example.com/artifactory',
    username: 'admin',
    password: 'pass',
};
const SRC_REPO = 'pypi-remote';
const DST_REPO = 'pypi-local';

function makeAdapter(
    httpRequester?: (opts: HttpRequestOptions) => Promise<HttpResponse>,
): PythonAdapter {
    return new PythonAdapter(SRC, SRC_REPO, DST, DST_REPO, httpRequester);
}

// ---------------------------------------------------------------------------
// 1. discoverVersions
// ---------------------------------------------------------------------------

describe('PythonAdapter.discoverVersions', () => {
    it('returns PackageRefs for wheel and sdist artifacts from AQL response', async () => {
        const aql = makeAqlResponse([
            { name: 'requests-2.28.0-py3-none-any.whl', path: 'requests', repo: SRC_REPO },
            { name: 'requests-2.27.1.tar.gz', path: 'requests', repo: SRC_REPO },
        ]);
        const { requester, calls } = staticMock(okResponse(aql));

        const refs = await makeAdapter(requester).discoverVersions('requests');
        expect(refs.length).toBe(2);
        const versions = refs.map((r) => r.version);
        expect(versions).toContain('2.28.0');
        expect(versions).toContain('2.27.1');
        refs.forEach((r) => expect(r.ecosystem).toBe('Python'));

        // Should POST to the AQL endpoint
        expect(calls[0]?.options.method).toBe('POST');
        expect(calls[0]?.options.path).toContain('/api/search/aql');
    });

    it('deduplicates versions when wheel and sdist for the same version are returned', async () => {
        const aql = makeAqlResponse([
            { name: 'requests-2.28.0-py3-none-any.whl', path: 'requests', repo: SRC_REPO },
            { name: 'requests-2.28.0.tar.gz', path: 'requests', repo: SRC_REPO },
        ]);
        const { requester } = staticMock(okResponse(aql));

        const refs = await makeAdapter(requester).discoverVersions('requests');
        // 2.28.0 should appear only once despite two artifacts
        expect(refs.filter((r) => r.version === '2.28.0')).toHaveLength(1);
    });

    it('normalizes underscore distribution names to hyphens', async () => {
        const aql = makeAqlResponse([
            { name: 'my-lib-1.0.0-py3-none-any.whl', path: 'my-lib', repo: SRC_REPO },
        ]);
        const { requester } = staticMock(okResponse(aql));

        const refs = await makeAdapter(requester).discoverVersions('my_lib');
        expect(refs[0]?.coordinates).toBe('my-lib');
    });

    it('returns an empty array when no artifacts are found', async () => {
        const { requester } = staticMock(okResponse(makeAqlResponse([])));
        const refs = await makeAdapter(requester).discoverVersions('nonexistent');
        expect(refs).toEqual([]);
    });

    it('throws when AQL returns a non-2xx status', async () => {
        const { requester } = makeMockRequester(() => ({
            statusCode: 401,
            headers: {},
            body: Buffer.from('Unauthorized'),
        }));
        await expect(makeAdapter(requester).discoverVersions('requests')).rejects.toThrow(/401/);
    });

    it('includes Bearer Authorization header from API key', async () => {
        const { requester, calls } = staticMock(okResponse(makeAqlResponse([])));
        await makeAdapter(requester).discoverVersions('requests');
        expect(calls[0]?.options.headers['Authorization']).toBe(`Bearer ${SRC.apiKey}`);
    });
});

// ---------------------------------------------------------------------------
// 2. parseDependencies — wheel
// ---------------------------------------------------------------------------

describe('PythonAdapter.parseDependencies (wheel)', () => {
    it('parses Requires-Dist lines from wheel METADATA', async () => {
        const metadata = [
            'Metadata-Version: 2.1',
            'Name: requests',
            'Version: 2.28.0',
            'Requires-Dist: certifi>=2017.4.17',
            'Requires-Dist: charset-normalizer!=3.0.0,>=2',
            'Requires-Dist: urllib3>=1.21.1',
        ].join('\n');

        const wheelBuf = buildMinimalZip('requests-2.28.0.dist-info/METADATA', metadata);
        const deps = await makeAdapter().parseDependencies(wheelBuf);

        expect(deps.length).toBe(3);
        const coords = deps.map((d) => d.coordinates);
        expect(coords).toContain('certifi');
        expect(coords).toContain('charset-normalizer');
        expect(coords).toContain('urllib3');
        deps.forEach((d) => expect(d.ecosystem).toBe('Python'));
    });

    it('strips environment markers and extras from Requires-Dist', async () => {
        const metadata = [
            'Name: requests',
            'Requires-Dist: PySocks!=1.5.7,>=1.5.6 ; extra == "socks"',
            'Requires-Dist: chardet>=3.0.2 ; python_version < "3"',
        ].join('\n');

        const wheelBuf = buildMinimalZip('requests-2.28.0.dist-info/METADATA', metadata);
        const deps = await makeAdapter().parseDependencies(wheelBuf);

        // Both deps included (conservative: ignore markers)
        expect(deps.length).toBe(2);
        const pysocksRef = deps.find((d) => d.coordinates === 'pysocks');
        expect(pysocksRef).toBeDefined();
        // Version spec preserved; marker stripped
        expect(pysocksRef?.version).not.toContain(';');
    });

    it('returns empty array for wheel with no Requires-Dist lines', async () => {
        const metadata = 'Metadata-Version: 2.1\nName: simple\nVersion: 1.0\n';
        const wheelBuf = buildMinimalZip('simple-1.0.dist-info/METADATA', metadata);
        const deps = await makeAdapter().parseDependencies(wheelBuf);
        expect(deps).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 3. parseDependencies — sdist
// ---------------------------------------------------------------------------

describe('PythonAdapter.parseDependencies (sdist)', () => {
    it('parses Requires-Dist from PKG-INFO in a tar.gz sdist', async () => {
        const pkgInfo = [
            'Metadata-Version: 2.1',
            'Name: django',
            'Version: 4.2.0',
            'Requires-Dist: asgiref>=3.6.0',
            'Requires-Dist: sqlparse>=0.2.2',
        ].join('\n');

        const sdistBuf = buildMinimalTarGz('django-4.2.0/PKG-INFO', pkgInfo);
        const deps = await makeAdapter().parseDependencies(sdistBuf);

        expect(deps.length).toBe(2);
        const coords = deps.map((d) => d.coordinates);
        expect(coords).toContain('asgiref');
        expect(coords).toContain('sqlparse');
        deps.forEach((d) => expect(d.ecosystem).toBe('Python'));
    });

    it('returns empty array for an unrecognized binary format', async () => {
        const randomBytes = Buffer.from('this is neither a zip nor gzip stream');
        const deps = await makeAdapter().parseDependencies(randomBytes);
        expect(deps).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 4. download
// ---------------------------------------------------------------------------

describe('PythonAdapter.download', () => {
    it('returns artifact bytes after AQL lookup + download', async () => {
        const fileContent = Buffer.from('fake wheel bytes for numpy 1.24.0');
        const aqlResp = makeAqlResponse([
            { name: 'numpy-1.24.0-cp311-cp311-linux_x86_64.whl', path: 'numpy', repo: SRC_REPO },
        ]);
        let callCount = 0;
        const { requester } = makeMockRequester((_opts) => {
            if (callCount++ === 0) {
                return okResponse(aqlResp);
            }
            return { statusCode: 200, headers: {}, body: fileContent };
        });

        const bytes = await makeAdapter(requester).download({
            coordinates: 'numpy', version: '1.24.0', ecosystem: 'Python',
        });
        expect(bytes).toEqual(fileContent);
    });

    it('throws when no artifact matches the requested version', async () => {
        const aqlResp = makeAqlResponse([
            // only version 1.23.0 exists, not 1.24.0
            { name: 'numpy-1.23.0-cp311-cp311-linux_x86_64.whl', path: 'numpy', repo: SRC_REPO },
        ]);
        const { requester } = staticMock(okResponse(aqlResp));

        await expect(
            makeAdapter(requester).download({ coordinates: 'numpy', version: '1.24.0', ecosystem: 'Python' }),
        ).rejects.toThrow(/not found/i);
    });

    it('throws when the artifact download returns a non-2xx status', async () => {
        const aqlResp = makeAqlResponse([
            { name: 'numpy-1.24.0-cp311-cp311-linux_x86_64.whl', path: 'numpy', repo: SRC_REPO },
        ]);
        let callCount = 0;
        const { requester } = makeMockRequester((_opts) => {
            if (callCount++ === 0) {
                return okResponse(aqlResp);
            }
            return { statusCode: 403, headers: {}, body: Buffer.from('Forbidden') };
        });

        await expect(
            makeAdapter(requester).download({ coordinates: 'numpy', version: '1.24.0', ecosystem: 'Python' }),
        ).rejects.toThrow(/403/);
    });

    it('also matches version from sdist filename', async () => {
        const fileContent = Buffer.from('fake sdist bytes');
        const aqlResp = makeAqlResponse([
            { name: 'requests-2.28.0.tar.gz', path: 'requests', repo: SRC_REPO },
        ]);
        let callCount = 0;
        const { requester } = makeMockRequester((_opts) => {
            if (callCount++ === 0) {
                return okResponse(aqlResp);
            }
            return { statusCode: 200, headers: {}, body: fileContent };
        });

        const bytes = await makeAdapter(requester).download({
            coordinates: 'requests', version: '2.28.0', ecosystem: 'Python',
        });
        expect(bytes).toEqual(fileContent);
    });

    it('uses Authorization header for AQL and download requests', async () => {
        const fileContent = Buffer.from('fake bytes');
        const aqlResp = makeAqlResponse([
            { name: 'requests-2.28.0.tar.gz', path: 'requests', repo: SRC_REPO },
        ]);
        let callCount = 0;
        const { requester, calls } = makeMockRequester((_opts) => {
            if (callCount++ === 0) {
                return okResponse(aqlResp);
            }
            return { statusCode: 200, headers: {}, body: fileContent };
        });

        await makeAdapter(requester).download({ coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' });
        // Both AQL call and download call should carry auth
        expect(calls[0]?.options.headers['Authorization']).toBe(`Bearer ${SRC.apiKey}`);
        expect(calls[1]?.options.headers['Authorization']).toBe(`Bearer ${SRC.apiKey}`);
    });

    it('throws when AQL returns a non-2xx status', async () => {
        const { requester } = makeMockRequester(() => ({
            statusCode: 500,
            headers: {},
            body: Buffer.from('Server Error'),
        }));

        await expect(
            makeAdapter(requester).download({ coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' }),
        ).rejects.toThrow(/500/);
    });
});

// ---------------------------------------------------------------------------
// 5. upload
// ---------------------------------------------------------------------------

describe('PythonAdapter.upload', () => {
    const ref = { coordinates: 'requests', version: '2.28.0', ecosystem: 'Python' as const };
    const fakeBytes = Buffer.from('pkg bytes');

    it('returns { kind: "uploaded" } on HTTP 200', async () => {
        const { requester } = makeMockRequester(() => ({ statusCode: 200, headers: {}, body: Buffer.from('OK') }));
        const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
        expect(outcome).toEqual({ kind: 'uploaded' });
    });

    it('returns { kind: "uploaded" } on HTTP 201', async () => {
        const { requester } = makeMockRequester(() => ({ statusCode: 201, headers: {}, body: Buffer.from('Created') }));
        const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
        expect(outcome).toEqual({ kind: 'uploaded' });
    });

    it('returns { kind: "already_present" } on HTTP 409', async () => {
        const { requester } = makeMockRequester(() => ({ statusCode: 409, headers: {}, body: Buffer.from('Conflict') }));
        const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
        expect(outcome).toEqual({ kind: 'already_present' });
    });

    it('returns { kind: "failed", reason } on HTTP 500', async () => {
        const { requester } = makeMockRequester(() => ({
            statusCode: 500, headers: {}, body: Buffer.from('Internal Server Error'),
        }));
        const outcome = await makeAdapter(requester).upload(ref, fakeBytes);
        expect(outcome.kind).toBe('failed');
        if (outcome.kind === 'failed') {
            expect(outcome.reason).toContain('500');
        }
    });

    it('returns { kind: "failed", reason } when requester throws', async () => {
        const throwingRequester = async (_opts: HttpRequestOptions): Promise<HttpResponse> => {
            throw new Error('ECONNREFUSED connection refused');
        };
        const outcome = await makeAdapter(throwingRequester).upload(ref, fakeBytes);
        expect(outcome.kind).toBe('failed');
        if (outcome.kind === 'failed') {
            expect(outcome.reason).toContain('ECONNREFUSED');
        }
    });

    it('uses Basic auth header when destination has username/password', async () => {
        const { requester, calls } = makeMockRequester(() => ({ statusCode: 201, headers: {}, body: Buffer.from('Created') }));
        await makeAdapter(requester).upload(ref, fakeBytes);
        const auth = calls[0]?.options.headers['Authorization'] ?? '';
        expect(auth).toMatch(/^Basic /);
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        expect(decoded).toBe(`${DST.username}:${DST.password}`);
    });

    it('sends the file bytes as the request body', async () => {
        const content = Buffer.from('my-python-package-bytes');
        const { requester, calls } = makeMockRequester(() => ({ statusCode: 201, headers: {}, body: Buffer.from('Created') }));
        await makeAdapter(requester).upload(ref, content);
        expect(calls[0]?.options.body).toEqual(content);
    });

    it('PUTs to the destination Artifactory repo URL', async () => {
        const { requester, calls } = makeMockRequester(() => ({ statusCode: 201, headers: {}, body: Buffer.from('Created') }));
        await makeAdapter(requester).upload(ref, fakeBytes);
        expect(calls[0]?.options.method).toBe('PUT');
        expect(calls[0]?.options.hostname).toBe('dst.example.com');
        expect(calls[0]?.options.path).toContain(DST_REPO);
    });
});

// ---------------------------------------------------------------------------
// 6. Static properties
// ---------------------------------------------------------------------------

describe('PythonAdapter static properties', () => {
    it('has ecosystem = "Python"', () => {
        expect(makeAdapter().ecosystem).toBe('Python');
    });

    it('has targetRepositoryKind = "pypi"', () => {
        expect(makeAdapter().targetRepositoryKind).toBe('pypi');
    });
});
