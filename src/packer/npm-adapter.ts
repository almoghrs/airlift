/**
 * NpmAdapter — EcosystemAdapter implementation for npm packages.
 *
 * - discoverVersions: uses JFrog AQL to find all .tgz artifacts for the given coordinates
 * - parseDependencies: extracts package/package.json from a .tgz tarball and unions
 *   dependencies + optionalDependencies + peerDependencies
 * - download: fetches the .tgz from Source_Artifactory
 * - upload: PUTs the .tgz to Destination_Artifactory
 * - targetRepositoryKind: 'npm'
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
// HTTP abstraction
// ---------------------------------------------------------------------------

/** The shape of a single HTTP request/response cycle used internally. */
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

// ---------------------------------------------------------------------------
// Default HTTP(S) implementation
// ---------------------------------------------------------------------------

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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the bare package name used in the .tgz filename from an npm package name.
 * Scoped packages like @scope/name become scope-name in the filename.
 * Unscoped packages keep their name as-is.
 */
export function tgzBaseName(coordinates: string): string {
  if (coordinates.startsWith('@')) {
    // @scope/name -> scope-name
    const withoutAt = coordinates.slice(1); // scope/name
    return withoutAt.replace('/', '-');
  }
  return coordinates;
}

/** Build an Authorization header value from an ArtifactoryConfig. */
function authHeader(config: ArtifactoryConfig): string | undefined {
  if (config.apiKey) {
    return `Bearer ${config.apiKey}`;
  }
  if (config.username !== undefined && config.password !== undefined) {
    const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64');
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
  // basePath includes the path prefix (e.g. '/artifactory'), without trailing slash
  const basePath = url.pathname.replace(/\/$/, '');
  return { protocol, hostname, port, basePath };
}

// ---------------------------------------------------------------------------
// Tarball (tar+gzip) parsing — Node built-ins only (no 'tar' package)
// ---------------------------------------------------------------------------

/**
 * Parse a POSIX ustar/GNU tar header block (512 bytes).
 * Returns the filename and the file size in bytes, or null for end-of-archive blocks.
 */
function parseTarHeader(block: Buffer): { name: string; size: number } | null {
  // Check for end-of-archive (all-zero block)
  let allZero = true;
  for (let i = 0; i < 512; i++) {
    if (block[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) return null;

  // Name: bytes 0–99 (null-terminated)
  const rawName = block.subarray(0, 100);
  let nameEnd = rawName.indexOf(0);
  if (nameEnd === -1) nameEnd = 100;
  let name = rawName.subarray(0, nameEnd).toString('utf8');

  // For ustar format, the prefix field is at bytes 345–499; prepend it if non-empty
  const rawPrefix = block.subarray(345, 500);
  let prefixEnd = rawPrefix.indexOf(0);
  if (prefixEnd === -1) prefixEnd = 155;
  const prefix = rawPrefix.subarray(0, prefixEnd).toString('utf8');
  if (prefix.length > 0) {
    name = `${prefix}/${name}`;
  }

  // Size: bytes 124–135 (octal, null/space-terminated)
  const rawSize = block.subarray(124, 136).toString('utf8').trim().replace(/\0/g, '');
  const size = parseInt(rawSize, 8);

  return { name, size: isNaN(size) ? 0 : size };
}

/**
 * Extract a specific file from a .tgz Buffer.
 * Returns the file contents as a Buffer, or null if not found.
 *
 * Uses Node built-in zlib.gunzipSync + manual tar header parsing.
 */
export function extractFileFromTgz(tgzBuffer: Buffer, targetPath: string): Buffer | null {
  let tarBuffer: Buffer;
  try {
    tarBuffer = zlib.gunzipSync(tgzBuffer);
  } catch {
    throw new Error('Failed to gunzip tarball');
  }

  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const headerBlock = tarBuffer.subarray(offset, offset + 512);
    const header = parseTarHeader(headerBlock);

    if (header === null) {
      // End of archive
      break;
    }

    offset += 512; // advance past the header

    // Check if this is the file we want
    if (header.name === targetPath) {
      return tarBuffer.subarray(offset, offset + header.size);
    }

    // Skip the file data: rounded up to nearest 512-byte block
    const dataBlocks = Math.ceil(header.size / 512);
    offset += dataBlocks * 512;
  }

  return null;
}

/**
 * Parse the package.json bytes extracted from a .tgz and return the union of
 * dependencies, optionalDependencies, and peerDependencies as PackageRef[].
 *
 * Deduplication key is the package name only (coordinates). The first
 * occurrence in the priority order (dependencies → optionalDependencies →
 * peerDependencies) wins when the same name appears in multiple fields.
 */
export function parsePackageJsonDeps(pkgJsonBytes: Buffer): PackageRef[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(pkgJsonBytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Failed to parse package.json from tarball');
  }

  const result: PackageRef[] = [];
  const seenCoordinates = new Set<string>();

  function addDeps(deps: unknown): void {
    if (deps === null || typeof deps !== 'object' || Array.isArray(deps)) return;
    for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
      // Deduplicate by name (coordinates): first occurrence wins
      if (!seenCoordinates.has(name)) {
        seenCoordinates.add(name);
        result.push({
          coordinates: name,
          version: String(version),
          ecosystem: 'npm',
        });
      }
    }
  }

  addDeps(parsed['dependencies']);
  addDeps(parsed['optionalDependencies']);
  addDeps(parsed['peerDependencies']);

  return result;
}

// ---------------------------------------------------------------------------
// AQL response types
// ---------------------------------------------------------------------------

interface AqlItem {
  name: string;
  path: string;
  repo: string;
}

interface AqlResponse {
  results: AqlItem[];
}

/**
 * Extract a version string from an npm artifact name.
 * npm tarballs are named <basename>-<version>.tgz.
 * Given the package basename and the artifact filename, extract the version.
 */
export function extractVersionFromArtifactName(
  artifactName: string,
  coordinatesBaseName: string,
): string | null {
  // The artifact name is: <basename>-<version>.tgz
  const prefix = `${coordinatesBaseName}-`;
  if (!artifactName.startsWith(prefix) || !artifactName.endsWith('.tgz')) {
    return null;
  }
  const version = artifactName.slice(prefix.length, -4); // strip prefix and '.tgz'
  return version.length > 0 ? version : null;
}

// ---------------------------------------------------------------------------
// NpmAdapter
// ---------------------------------------------------------------------------

export class NpmAdapter implements EcosystemAdapter {
  readonly ecosystem = 'npm' as const;
  readonly targetRepositoryKind: TargetRepositoryKind = 'npm';

  private readonly srcConfig: ArtifactoryConfig;
  private readonly srcRepoKey: string;
  private readonly destConfig: ArtifactoryConfig;
  private readonly destRepoKey: string;
  private readonly _httpRequester: HttpRequester;

  /**
   * @param srcConfig       ArtifactoryConfig for the Source_Artifactory (downloads).
   * @param srcRepoKey      Repository key on the source Artifactory (e.g. "npm-remote").
   * @param destConfig      ArtifactoryConfig for the Destination_Artifactory (uploads).
   * @param destRepoKey     Repository key on the destination Artifactory (e.g. "npm-local").
   * @param httpRequester   Optional HTTP requester; defaults to the real HTTPS/HTTP transport.
   *                        Pass a mock for testing.
   */
  constructor(
    srcConfig: ArtifactoryConfig,
    srcRepoKey: string,
    destConfig: ArtifactoryConfig,
    destRepoKey: string,
    httpRequester: HttpRequester = defaultHttpRequester,
  ) {
    this.srcConfig = srcConfig;
    this.srcRepoKey = srcRepoKey;
    this.destConfig = destConfig;
    this.destRepoKey = destRepoKey;
    this._httpRequester = httpRequester;
  }

  // -------------------------------------------------------------------------
  // discoverVersions
  // -------------------------------------------------------------------------

  /**
   * Use JFrog AQL to discover all .tgz versions of a package in the source repo.
   *
   * AQL query:
   *   items.find({"repo": "<repoKey>", "name": {"$match": "*.tgz"},
   *               "path": {"$match": "<coordinates>/*"}})
   *          .include("name","path","repo")
   *
   * Requirements: 8.1
   */
  async discoverVersions(coordinates: string): Promise<PackageRef[]> {
    const { protocol, hostname, port, basePath } = parseBaseUrl(this.srcConfig.baseUrl);

    const aqlQuery =
      `items.find({"repo": "${this.srcRepoKey}", "name": {"$match": "*.tgz"}, ` +
      `"path": {"$match": "${coordinates}/*"}}).include("name","path","repo")`;
    const bodyBuffer = Buffer.from(aqlQuery, 'utf8');

    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
      'Content-Length': String(bodyBuffer.length),
    };
    const auth = authHeader(this.srcConfig);
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

    if (response.statusCode !== 200) {
      throw new Error(
        `AQL search failed for '${coordinates}': HTTP ${response.statusCode} — ${response.body.toString('utf8')}`,
      );
    }

    let aqlResult: AqlResponse;
    try {
      aqlResult = JSON.parse(response.body.toString('utf8')) as AqlResponse;
    } catch {
      throw new Error(`Failed to parse AQL response for '${coordinates}'`);
    }

    const baseName = tgzBaseName(coordinates);
    const refs: PackageRef[] = [];
    const seenVersions = new Set<string>();

    for (const item of aqlResult.results) {
      const version = extractVersionFromArtifactName(item.name, baseName);
      if (version !== null && !seenVersions.has(version)) {
        seenVersions.add(version);
        refs.push({
          coordinates,
          version,
          ecosystem: 'npm',
        });
      }
    }

    return refs;
  }

  // -------------------------------------------------------------------------
  // parseDependencies
  // -------------------------------------------------------------------------

  /**
   * Extract package/package.json from a .tgz archive and return the union of
   * dependencies + optionalDependencies + peerDependencies as PackageRef[].
   *
   * The version field is the semver range string from package.json; the
   * DependencyResolver will call discoverVersions to find concrete versions.
   *
   * Requirements: 8.3
   */
  async parseDependencies(fileBytes: Buffer): Promise<PackageRef[]> {
    const pkgJsonBytes = extractFileFromTgz(fileBytes, 'package/package.json');
    if (pkgJsonBytes === null) {
      // Some tarballs may not have the package/ prefix; try without it
      const fallback = extractFileFromTgz(fileBytes, 'package.json');
      if (fallback === null) {
        return [];
      }
      return parsePackageJsonDeps(fallback);
    }
    return parsePackageJsonDeps(pkgJsonBytes);
  }

  // -------------------------------------------------------------------------
  // download
  // -------------------------------------------------------------------------

  /**
   * Download a .tgz from Source_Artifactory.
   *
   * URL pattern: <baseUrl>/<repoKey>/<coordinates>/-/<basename>-<version>.tgz
   *
   * Requirements: 8.1
   */
  async download(ref: PackageRef): Promise<Buffer> {
    const { protocol, hostname, port, basePath } = parseBaseUrl(this.srcConfig.baseUrl);
    const baseName = tgzBaseName(ref.coordinates);
    const tgzPath =
      `${basePath}/${this.srcRepoKey}/${ref.coordinates}/-/${baseName}-${ref.version}.tgz`;

    const headers: Record<string, string> = {};
    const auth = authHeader(this.srcConfig);
    if (auth !== undefined) headers['Authorization'] = auth;

    const response = await this._httpRequester({
      protocol,
      hostname,
      port,
      method: 'GET',
      path: tgzPath,
      headers,
    });

    if (response.statusCode !== 200) {
      throw new Error(
        `Download failed for ${ref.coordinates}@${ref.version}: HTTP ${response.statusCode}`,
      );
    }

    return response.body;
  }

  // -------------------------------------------------------------------------
  // upload
  // -------------------------------------------------------------------------

  /**
   * Upload a .tgz to Destination_Artifactory via HTTP PUT.
   *
   * URL pattern: <destBaseUrl>/<destRepoKey>/<coordinates>/-/<basename>-<version>.tgz
   *
   * Returns:
   *   { kind: 'uploaded' }        on 201
   *   { kind: 'already_present' } on 409
   *   { kind: 'failed', reason }  on other errors
   *
   * Requirements: 4.2
   */
  async upload(ref: PackageRef, fileBytes: Buffer): Promise<UploadOutcome> {
    const { protocol, hostname, port, basePath } = parseBaseUrl(this.destConfig.baseUrl);
    const baseName = tgzBaseName(ref.coordinates);
    const putPath =
      `${basePath}/${this.destRepoKey}/${ref.coordinates}/-/${baseName}-${ref.version}.tgz`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(fileBytes.length),
    };
    const auth = authHeader(this.destConfig);
    if (auth !== undefined) headers['Authorization'] = auth;

    let response: HttpResponse;
    try {
      response = await this._httpRequester({
        protocol,
        hostname,
        port,
        method: 'PUT',
        path: putPath,
        headers,
        body: fileBytes,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { kind: 'failed', reason };
    }

    if (response.statusCode === 201) {
      return { kind: 'uploaded' };
    }
    if (response.statusCode === 409) {
      return { kind: 'already_present' };
    }

    const reason = `HTTP ${response.statusCode}: ${response.body.toString('utf8').slice(0, 200)}`;
    return { kind: 'failed', reason };
  }
}
