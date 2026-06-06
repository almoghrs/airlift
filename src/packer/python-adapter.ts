/**
 * PythonAdapter — EcosystemAdapter implementation for Python (PyPI) packages.
 *
 * Talks to a JFrog Artifactory instance using its REST + AQL APIs over Node's
 * built-in `https`/`http` modules (no external HTTP library).
 *
 * Version discovery  : AQL query for `.whl` and `.tar.gz` artifacts.
 * Dependency parsing : parses `Requires-Dist` from wheel METADATA or sdist PKG-INFO.
 * Download           : fetches the artifact via the Artifactory download API.
 * Upload             : PUTs the artifact to the destination PyPI repo.
 *
 * Authentication is the same as NpmAdapter: `apiKey` → Bearer header,
 * `username`+`password` → Basic header.
 *
 * The HTTP layer is injected via an optional `HttpRequester` parameter so tests
 * can supply a mock without monkey-patching Node's built-in modules.
 *
 * Requirements: 4.2, 8.1, 8.3
 */

import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import type {
    ArtifactoryConfig,
    EcosystemAdapter,
    TargetRepositoryKind,
    UploadOutcome,
} from '../shared/ecosystem-adapter.js';
import type { PackageRef } from '../types/index.js';

// ---------------------------------------------------------------------------
// HTTP abstraction (same interface as NpmAdapter; inlined to avoid circular deps)
// ---------------------------------------------------------------------------

/** The shape of a single HTTP request/response cycle. */
export interface HttpRequestOptions {
    protocol: string;
    hostname: string;
    port: number;
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
}

export interface HttpResponse {
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
}

export type HttpRequester = (options: HttpRequestOptions) => Promise<HttpResponse>;

/**
 * Real implementation that dispatches over Node's built-in https/http modules.
 */
export function defaultHttpRequester(options: HttpRequestOptions): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
        const isHttps = options.protocol === 'https:';
        const transport: typeof https | typeof http = isHttps ? https : http;

        const reqOptions: https.RequestOptions = {
            protocol: options.protocol,
            hostname: options.hostname,
            port: options.port,
            method: options.method,
            path: options.path,
            headers: options.headers,
        };

        const req = transport.request(reqOptions, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
            res.on('error', reject);
        });

        req.on('error', reject);

        if (options.body !== undefined && options.body.length > 0) {
            req.write(options.body);
        }
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Internal helpers — Python name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Python distribution name to lowercase with hyphens
 * (PEP 503 / PEP 625 canonical form).
 */
export function normalizePythonName(name: string): string {
    // Replace underscores, dots, and runs of hyphens with a single hyphen, then lowercase.
    return name.replace(/[-_.]+/g, '-').toLowerCase();
}

// ---------------------------------------------------------------------------
// Internal helpers — URL/auth (mirrors NpmAdapter helpers)
// ---------------------------------------------------------------------------

/** Build the Authorization header value from an ArtifactoryConfig. */
function buildAuthHeader(cfg: ArtifactoryConfig): string | undefined {
    if (cfg.apiKey) {
        return `Bearer ${cfg.apiKey}`;
    }
    if (cfg.username !== undefined && cfg.password !== undefined) {
        const encoded = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
        return `Basic ${encoded}`;
    }
    return undefined;
}

/**
 * Parse the base URL into component parts suitable for HttpRequestOptions.
 * Returns protocol, hostname, port, and basePath.
 */
function parseBaseUrl(baseUrl: string): {
    protocol: string;
    hostname: string;
    port: number;
    basePath: string;
} {
    const url = new URL(baseUrl);
    const protocol = url.protocol; // 'https:' or 'http:'
    const hostname = url.hostname;
    const port = url.port
        ? parseInt(url.port, 10)
        : protocol === 'https:'
          ? 443
          : 80;
    const basePath = url.pathname.replace(/\/$/, '');
    return { protocol, hostname, port, basePath };
}

// ---------------------------------------------------------------------------
// Internal helpers — version extraction from filenames
// ---------------------------------------------------------------------------

/**
 * Extract the version string from a wheel filename.
 * Wheel naming spec: `{distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl`
 */
export function parseWheelVersion(filename: string): string | null {
    // Strip .whl suffix
    const base = filename.endsWith('.whl') ? filename.slice(0, -4) : filename;
    // Parts are separated by `-`; version is always the second segment.
    const parts = base.split('-');
    return parts.length >= 2 ? (parts[1] ?? null) : null;
}

/**
 * Extract the version string from a sdist filename.
 * Sdist naming: `{distribution}-{version}.tar.gz`
 */
export function parseSdistVersion(filename: string): string | null {
    // Strip .tar.gz
    const base = filename.endsWith('.tar.gz') ? filename.slice(0, -7) : filename;
    // The last hyphen-separated segment is the version.
    const idx = base.lastIndexOf('-');
    return idx >= 0 ? base.slice(idx + 1) : null;
}

// ---------------------------------------------------------------------------
// Internal helpers — ZIP (wheel) parsing
// ---------------------------------------------------------------------------

/**
 * Minimal ZIP end-of-central-directory (EOCD) parser.
 * Returns the offset and size of the central directory.
 */
function findZipCentralDirectory(buf: Buffer): { offset: number; size: number; count: number } | null {
    // EOCD signature: 0x06054b50 (little-endian: 50 4b 05 06)
    const EOCD_SIG = 0x06054b50;
    const EOCD_SIZE = 22; // minimum size (no comment)

    // Search backwards for EOCD
    for (let i = buf.length - EOCD_SIZE; i >= 0; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            const diskEntries = buf.readUInt16LE(i + 8);
            const centralDirSize = buf.readUInt32LE(i + 12);
            const centralDirOffset = buf.readUInt32LE(i + 16);
            return { offset: centralDirOffset, size: centralDirSize, count: diskEntries };
        }
    }
    return null;
}

interface ZipEntry {
    filename: string;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    compressionMethod: number;
}

/**
 * Parse the ZIP central directory and return a list of entries.
 */
function parseZipEntries(buf: Buffer): ZipEntry[] {
    const cd = findZipCentralDirectory(buf);
    if (!cd) return [];

    const entries: ZipEntry[] = [];
    let pos = cd.offset;
    const CDH_SIG = 0x02014b50; // central directory header signature

    for (let i = 0; i < cd.count; i++) {
        if (pos + 46 > buf.length) break;
        if (buf.readUInt32LE(pos) !== CDH_SIG) break;

        const compressionMethod = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const uncompressedSize = buf.readUInt32LE(pos + 24);
        const filenameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localHeaderOffset = buf.readUInt32LE(pos + 42);

        const filename = buf.slice(pos + 46, pos + 46 + filenameLen).toString('utf8');
        entries.push({ filename, compressedSize, uncompressedSize, localHeaderOffset, compressionMethod });

        pos += 46 + filenameLen + extraLen + commentLen;
    }
    return entries;
}

/**
 * Extract a specific file's bytes from a ZIP buffer.
 * Returns the raw (uncompressed) bytes or null if not found / unsupported.
 */
function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
    const LFH_SIG = 0x04034b50; // local file header signature
    const offset = entry.localHeaderOffset;

    if (offset + 30 > buf.length) return null;
    if (buf.readUInt32LE(offset) !== LFH_SIG) return null;

    const filenameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + filenameLen + extraLen;
    const compressedData = buf.slice(dataStart, dataStart + entry.compressedSize);

    if (entry.compressionMethod === 0) {
        // Stored (no compression)
        return compressedData;
    } else if (entry.compressionMethod === 8) {
        // DEFLATE
        try {
            return zlib.inflateRawSync(compressedData);
        } catch {
            return null;
        }
    }
    // Unsupported compression method
    return null;
}

/**
 * Extract the `*.dist-info/METADATA` file from a wheel (ZIP) buffer.
 * Returns the raw text content or null if not found.
 */
export function extractWheelMetadata(wheelBuf: Buffer): string | null {
    const entries = parseZipEntries(wheelBuf);
    // Find the METADATA file inside any *.dist-info/ directory
    const metadataEntry = entries.find(
        (e) => e.filename.includes('.dist-info/') && e.filename.endsWith('/METADATA'),
    );
    if (!metadataEntry) return null;

    const bytes = extractZipEntry(wheelBuf, metadataEntry);
    if (!bytes) return null;
    return bytes.toString('utf8');
}

// ---------------------------------------------------------------------------
// Internal helpers — tar.gz (sdist) parsing
// ---------------------------------------------------------------------------

/**
 * Decompress a gzipped buffer and scan for a PKG-INFO file.
 * Uses a minimal TAR header parser to walk the archive.
 * Returns the text content of the first PKG-INFO found, or null.
 */
export function extractSdistPkgInfo(sdistBuf: Buffer): string | null {
    let tarBuf: Buffer;
    try {
        tarBuf = zlib.gunzipSync(sdistBuf);
    } catch {
        return null;
    }

    // Walk the TAR archive (512-byte blocks, ustar / GNU tar format)
    let pos = 0;
    while (pos + 512 <= tarBuf.length) {
        const header = tarBuf.slice(pos, pos + 512);

        // Read filename (first 100 bytes, NUL-terminated)
        const nameEnd = header.indexOf(0);
        const name = header.slice(0, nameEnd >= 0 ? nameEnd : 100).toString('utf8');

        if (!name) break; // end-of-archive

        // File size in octal (bytes 124–135)
        const sizeOctal = header.slice(124, 136).toString('utf8').trim().replace(/\0/g, '');
        const size = parseInt(sizeOctal, 8) || 0;

        pos += 512; // move past header

        // Check if this is a PKG-INFO file (top-level or */PKG-INFO)
        const basename = name.split('/').pop() ?? '';
        if (basename === 'PKG-INFO' && size > 0) {
            const content = tarBuf.slice(pos, pos + size).toString('utf8');
            return content;
        }

        // Skip file data (rounded up to 512-byte blocks)
        const blocks = Math.ceil(size / 512);
        pos += blocks * 512;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Internal helpers — Requires-Dist parsing
// ---------------------------------------------------------------------------

/**
 * Detect whether `fileBytes` looks like a wheel (ZIP magic bytes PK\x03\x04).
 */
function isWheelBuffer(buf: Buffer): boolean {
    return buf.length >= 4 &&
        buf[0] === 0x50 && // P
        buf[1] === 0x4b && // K
        buf[2] === 0x03 &&
        buf[3] === 0x04;
}

/**
 * Detect whether `fileBytes` looks like a gzip stream (\x1f\x8b).
 */
function isGzipBuffer(buf: Buffer): boolean {
    return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/**
 * Parse a single `Requires-Dist` line into `{ distribution, versionSpec }`.
 * Format: `name [extra] [versionSpec] [; marker]`
 *
 * We strip extras and environment markers conservatively (include all).
 */
interface RequiresDist {
    distribution: string;
    versionSpec: string;
}

function parseRequiresDist(line: string): RequiresDist | null {
    // Strip inline comments
    const noComment = line.includes('#') ? line.slice(0, line.indexOf('#')) : line;
    const trimmed = noComment.trim();
    if (!trimmed) return null;

    // Split off environment marker (the part after `;`)
    const semiIdx = trimmed.indexOf(';');
    const withoutMarker = semiIdx >= 0 ? trimmed.slice(0, semiIdx).trim() : trimmed;

    // Strip extras: `name[extra1,extra2]` → `name`
    const bracketIdx = withoutMarker.indexOf('[');
    const nameAndSpec = bracketIdx >= 0
        ? withoutMarker.slice(0, bracketIdx).trim() + withoutMarker.slice(withoutMarker.indexOf(']') + 1).trim()
        : withoutMarker;

    // Split into name part and version spec part
    // Version operators: ==, !=, >=, <=, ~=, >, <
    const versionMatch = nameAndSpec.match(/^([A-Za-z0-9._-]+)\s*([><!~=].*)?$/);
    if (!versionMatch) return null;

    const distribution = normalizePythonName(versionMatch[1] ?? '');
    const versionSpec = (versionMatch[2] ?? '').trim();

    if (!distribution) return null;

    return { distribution, versionSpec };
}

/**
 * Extract all `Requires-Dist` values from distribution metadata text.
 */
export function parseRequiresDistLines(metadata: string): RequiresDist[] {
    const results: RequiresDist[] = [];
    for (const line of metadata.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('requires-dist:')) {
            const value = trimmed.slice('requires-dist:'.length).trim();
            const parsed = parseRequiresDist(value);
            if (parsed) {
                results.push(parsed);
            }
        }
    }
    return results;
}

// ---------------------------------------------------------------------------
// Internal helpers — AQL
// ---------------------------------------------------------------------------

/**
 * Build an AQL query that finds all wheel and sdist artifacts in `repoKey`
 * whose name matches the given (normalized) distribution name.
 */
function buildVersionDiscoveryAql(repoKey: string, normalizedName: string): string {
    const prefix = `${normalizedName}-`;
    return `items.find({
  "repo": "${repoKey}",
  "$or": [
    {"name": {"$match": "${prefix}*.whl"}},
    {"name": {"$match": "${prefix}*.tar.gz"}}
  ]
}).include("name", "path", "repo")`;
}

interface AqlItem {
    name: string;
    path: string;
    repo: string;
}

interface AqlResponse {
    results: AqlItem[];
}

// ---------------------------------------------------------------------------
// PythonAdapter
// ---------------------------------------------------------------------------

/**
 * EcosystemAdapter for the Python (PyPI) ecosystem.
 *
 * Uses JFrog Artifactory AQL for version discovery and download, and the
 * Artifactory content API for artifact upload.
 *
 * Constructor accepts separate source and destination configs so the same
 * adapter instance can handle the full packing + importing lifecycle.
 *
 * @param srcConfig     ArtifactoryConfig for the Source_Artifactory (downloads).
 * @param srcRepoKey    Repository key on the source Artifactory (e.g. "pypi-remote").
 * @param dstConfig     ArtifactoryConfig for the Destination_Artifactory (uploads).
 * @param dstRepoKey    Repository key on the destination Artifactory (e.g. "pypi-local").
 * @param httpRequester Optional HTTP requester; defaults to the real HTTPS/HTTP transport.
 *                      Pass a mock for testing.
 */
export class PythonAdapter implements EcosystemAdapter {
    readonly ecosystem = 'Python' as const;
    readonly targetRepositoryKind: TargetRepositoryKind = 'pypi';

    private readonly _httpRequester: HttpRequester;

    constructor(
        private readonly srcConfig: ArtifactoryConfig,
        private readonly srcRepoKey: string,
        private readonly dstConfig: ArtifactoryConfig,
        private readonly dstRepoKey: string,
        httpRequester: HttpRequester = defaultHttpRequester,
    ) {
        this._httpRequester = httpRequester;
    }

    // -------------------------------------------------------------------------
    // discoverVersions
    // -------------------------------------------------------------------------

    /**
     * Discover all available versions for a Python distribution on the source
     * Artifactory by querying AQL for `.whl` and `.tar.gz` artifacts.
     *
     * The distribution name is normalized to lowercase with hyphens before the
     * query so that `my_lib` and `My-Lib` both resolve consistently.
     */
    async discoverVersions(coordinates: string): Promise<PackageRef[]> {
        const normalizedName = normalizePythonName(coordinates);
        const aqlQuery = buildVersionDiscoveryAql(this.srcRepoKey, normalizedName);
        const bodyBuffer = Buffer.from(aqlQuery, 'utf8');

        const { protocol, hostname, port, basePath } = parseBaseUrl(this.srcConfig.baseUrl);
        const headers: Record<string, string> = {
            'Content-Type': 'text/plain',
            'Content-Length': String(bodyBuffer.length),
        };
        const auth = buildAuthHeader(this.srcConfig);
        if (auth !== undefined) headers['Authorization'] = auth;

        const response = await this._httpRequester({
            protocol,
            hostname,
            port,
            method: 'POST',
            path: `${basePath}/api/search/aql`,
            headers,
            body: bodyBuffer,
        });

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(
                `AQL discovery failed for '${coordinates}': HTTP ${response.statusCode}`,
            );
        }

        let parsed: AqlResponse;
        try {
            parsed = JSON.parse(response.body.toString('utf8')) as AqlResponse;
        } catch {
            throw new Error(`Failed to parse AQL response for '${coordinates}'`);
        }

        // Deduplicate by version
        const versionsSeen = new Set<string>();
        const refs: PackageRef[] = [];

        for (const item of parsed.results) {
            const { name } = item;
            let version: string | null = null;

            if (name.endsWith('.whl')) {
                version = parseWheelVersion(name);
            } else if (name.endsWith('.tar.gz')) {
                version = parseSdistVersion(name);
            }

            if (version && !versionsSeen.has(version)) {
                versionsSeen.add(version);
                refs.push({
                    coordinates: normalizedName,
                    version,
                    ecosystem: 'Python',
                });
            }
        }

        return refs;
    }

    // -------------------------------------------------------------------------
    // parseDependencies
    // -------------------------------------------------------------------------

    /**
     * Parse `Requires-Dist` specifiers from a wheel or sdist artifact.
     *
     * - Wheel (ZIP): extracts `*.dist-info/METADATA`.
     * - Sdist (tar.gz): gunzips + untars to find `PKG-INFO`.
     *
     * Environment markers are stripped; all declared dependencies are returned
     * (conservative inclusion). The `version` field on returned refs carries the
     * version specifier string (e.g. `>=1.0.0,<2.0.0`) for downstream use.
     */
    async parseDependencies(fileBytes: Buffer): Promise<PackageRef[]> {
        let metadataText: string | null = null;

        if (isWheelBuffer(fileBytes)) {
            metadataText = extractWheelMetadata(fileBytes);
        } else if (isGzipBuffer(fileBytes)) {
            metadataText = extractSdistPkgInfo(fileBytes);
        }

        if (!metadataText) {
            // Unknown format or no metadata found — return empty deps.
            return [];
        }

        const requiresDist = parseRequiresDistLines(metadataText);
        return requiresDist.map((rd) => ({
            coordinates: rd.distribution,
            version: rd.versionSpec,
            ecosystem: 'Python' as const,
        }));
    }

    // -------------------------------------------------------------------------
    // download
    // -------------------------------------------------------------------------

    /**
     * Download a specific package version from the source Artifactory.
     *
     * First uses AQL to locate the artifact path, then downloads it via the
     * direct file download URL (`<baseUrl>/<repo>/<path>/<name>`).
     */
    async download(ref: PackageRef): Promise<Buffer> {
        const normalizedName = normalizePythonName(ref.coordinates);
        const aqlQuery = buildVersionDiscoveryAql(this.srcRepoKey, normalizedName);
        const bodyBuffer = Buffer.from(aqlQuery, 'utf8');

        const { protocol, hostname, port, basePath } = parseBaseUrl(this.srcConfig.baseUrl);
        const aqlHeaders: Record<string, string> = {
            'Content-Type': 'text/plain',
            'Content-Length': String(bodyBuffer.length),
        };
        const auth = buildAuthHeader(this.srcConfig);
        if (auth !== undefined) aqlHeaders['Authorization'] = auth;

        const aqlResponse = await this._httpRequester({
            protocol,
            hostname,
            port,
            method: 'POST',
            path: `${basePath}/api/search/aql`,
            headers: aqlHeaders,
            body: bodyBuffer,
        });

        if (aqlResponse.statusCode < 200 || aqlResponse.statusCode >= 300) {
            throw new Error(
                `AQL lookup failed for '${ref.coordinates}@${ref.version}': HTTP ${aqlResponse.statusCode}`,
            );
        }

        let parsed: AqlResponse;
        try {
            parsed = JSON.parse(aqlResponse.body.toString('utf8')) as AqlResponse;
        } catch {
            throw new Error(`Failed to parse AQL response for '${ref.coordinates}@${ref.version}'`);
        }

        // Find the artifact matching this version
        const target = parsed.results.find((item) => {
            const { name } = item;
            if (name.endsWith('.whl')) {
                return parseWheelVersion(name) === ref.version;
            }
            if (name.endsWith('.tar.gz')) {
                return parseSdistVersion(name) === ref.version;
            }
            return false;
        });

        if (!target) {
            throw new Error(
                `Artifact not found for '${ref.coordinates}@${ref.version}' in '${this.srcRepoKey}'`,
            );
        }

        // Build the download URL and fetch using the parsed base URL components
        // The artifact path from AQL is relative: <path>/<name>
        const artifactPath = `${basePath}/${target.repo}/${target.path}/${target.name}`;
        const downloadHeaders: Record<string, string> = {};
        if (auth !== undefined) downloadHeaders['Authorization'] = auth;

        const downloadResponse = await this._httpRequester({
            protocol,
            hostname,
            port,
            method: 'GET',
            path: artifactPath,
            headers: downloadHeaders,
        });

        if (downloadResponse.statusCode < 200 || downloadResponse.statusCode >= 300) {
            throw new Error(
                `Download failed for '${ref.coordinates}@${ref.version}': HTTP ${downloadResponse.statusCode}`,
            );
        }

        return downloadResponse.body;
    }

    // -------------------------------------------------------------------------
    // upload
    // -------------------------------------------------------------------------

    /**
     * Upload a package version to the destination Artifactory PyPI repository.
     *
     * Uses the Artifactory deploy API (PUT) at the path:
     *   `<basePath>/<dstRepoKey>/<coordinates>/<version>/<filename>`
     *
     * Returns:
     *   - `{ kind: 'already_present' }` on HTTP 409 Conflict.
     *   - `{ kind: 'uploaded' }` on 2xx.
     *   - `{ kind: 'failed' }` on other status codes.
     */
    async upload(ref: PackageRef, fileBytes: Buffer): Promise<UploadOutcome> {
        const normalizedName = normalizePythonName(ref.coordinates);
        const filename = `${normalizedName}-${ref.version}.tar.gz`;

        const { protocol, hostname, port, basePath } = parseBaseUrl(this.dstConfig.baseUrl);
        const uploadPath = `${basePath}/${this.dstRepoKey}/${normalizedName}/${ref.version}/${filename}`;

        const auth = buildAuthHeader(this.dstConfig);
        const headers: Record<string, string> = {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(fileBytes.length),
        };
        if (auth !== undefined) headers['Authorization'] = auth;

        let response: HttpResponse;
        try {
            response = await this._httpRequester({
                protocol,
                hostname,
                port,
                method: 'PUT',
                path: uploadPath,
                headers,
                body: fileBytes,
            });
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return { kind: 'failed', reason };
        }

        const { statusCode } = response;

        if (statusCode === 409) {
            return { kind: 'already_present' };
        }
        if (statusCode >= 200 && statusCode < 300) {
            return { kind: 'uploaded' };
        }
        return {
            kind: 'failed',
            reason: `HTTP ${statusCode}: ${response.body.toString('utf8').slice(0, 200)}`,
        };
    }
}
