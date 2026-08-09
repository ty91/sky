import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  constants,
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { PRODUCT_VERSION } from '../product-version.js';
import { RUNTIME_KIND } from '../runtime-identity.js';
import { restartLaunchAgent } from '../service/launch-agent.js';

const execFileAsync = promisify(execFile);
const DEFAULT_RELEASE_API_URL = 'https://api.github.com/repos/ty91/sky/releases/latest';
const RELEASE_REQUEST_TIMEOUT_MS = 30_000;
const ASSET_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;

type ReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type LatestRelease = {
  version: string;
  assets: ReleaseAsset[];
};

type UpdateResult =
  | { changed: false; version: string }
  | { changed: true; previousVersion: string; version: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestHeaders(): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': `sky/${PRODUCT_VERSION}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function fetchLatestRelease(releaseApiUrl: string): Promise<LatestRelease> {
  let response: Response;
  try {
    response = await fetch(releaseApiUrl, {
      headers: requestHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not check the latest Sky release: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`Could not check the latest Sky release: HTTP ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Could not read the latest Sky release response: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (typeof body !== 'object' || body === null) {
    throw new Error('The latest Sky release response was not an object.');
  }

  const tagName = 'tag_name' in body ? body.tag_name : undefined;
  const assets = 'assets' in body ? body.assets : undefined;
  if (typeof tagName !== 'string' || !/^v[0-9A-Za-z][0-9A-Za-z.-]*$/.test(tagName)) {
    throw new Error('The latest Sky release has an invalid version tag.');
  }
  if (!Array.isArray(assets)) {
    throw new Error('The latest Sky release has no asset list.');
  }

  const parsedAssets = assets.map((asset): ReleaseAsset => {
    if (
      typeof asset !== 'object' ||
      asset === null ||
      !('name' in asset) ||
      typeof asset.name !== 'string' ||
      !('browser_download_url' in asset) ||
      typeof asset.browser_download_url !== 'string'
    ) {
      throw new Error('The latest Sky release contains an invalid asset.');
    }
    return { name: asset.name, browser_download_url: asset.browser_download_url };
  });
  return { version: tagName.slice(1), assets: parsedAssets };
}

function requireAsset(release: LatestRelease, name: string): ReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`The latest Sky release is missing ${name}.`);
  return asset;
}

async function download(
  asset: ReleaseAsset,
  destination: string,
  maximumBytes: number,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(asset.browser_download_url, {
      headers: requestHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Download failed for ${asset.name}: ${errorMessage(error)}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Download failed for ${asset.name}: HTTP ${response.status}.`);
  }
  if (!response.body) throw new Error(`Download failed for ${asset.name}: empty response body.`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`Download failed for ${asset.name}: response is too large.`);
  }

  const output = await open(destination, 'wx', 0o600);
  try {
    let receivedBytes = 0;
    for await (const chunk of response.body) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maximumBytes) {
        throw new Error(`response exceeded ${maximumBytes} bytes`);
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await output.write(chunk.subarray(offset));
        if (bytesWritten === 0) throw new Error('file write made no progress');
        offset += bytesWritten;
      }
    }
    await output.sync();
  } catch (error) {
    throw new Error(`Download failed for ${asset.name}: ${errorMessage(error)}`, { cause: error });
  } finally {
    await output.close();
  }
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyChecksum(
  archivePath: string,
  checksumPath: string,
  archiveName: string,
): Promise<void> {
  const checksum = await readFile(checksumPath, 'utf8');
  const match = checksum.match(/^([0-9a-fA-F]{64})  ([^\r\n]+)\r?\n?$/);
  if (!match || match[2] !== archiveName) {
    throw new Error(`Checksum file for ${archiveName} is invalid.`);
  }
  const actual = await sha256(archivePath);
  if (actual.toLowerCase() !== match[1].toLowerCase()) {
    throw new Error(`Checksum verification failed for ${archiveName}.`);
  }
}

async function extractExecutable(archivePath: string, directory: string): Promise<string> {
  let entries: string;
  try {
    const result = await execFileAsync('/usr/bin/tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    entries = result.stdout.trimEnd();
  } catch (error) {
    throw new Error(`Could not read the downloaded Sky archive: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (entries !== 'sky') throw new Error('The downloaded Sky archive must contain only sky.');

  try {
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', directory]);
  } catch (error) {
    throw new Error(`Could not extract the downloaded Sky archive: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const executable = path.join(directory, 'sky');
  const stats = await lstat(executable);
  if (!stats.isFile()) throw new Error('The downloaded sky is not a regular file.');
  await access(executable, constants.X_OK);
  return executable;
}

async function verifyExecutableVersion(executable: string, version: string): Promise<void> {
  let output: string;
  try {
    const result = await execFileAsync(executable, ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    output = result.stdout.trim();
  } catch (error) {
    throw new Error(`Could not read the downloaded Sky version: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (output !== version) {
    throw new Error(`Downloaded Sky version ${output} does not match ${version}.`);
  }
}

async function verifyExecutableArchitecture(executable: string): Promise<void> {
  let description: string;
  let architectures: string;
  try {
    const [fileResult, lipoResult] = await Promise.all([
      execFileAsync('/usr/bin/file', ['-b', executable], { encoding: 'utf8' }),
      execFileAsync('/usr/bin/lipo', ['-archs', executable], { encoding: 'utf8' }),
    ]);
    description = fileResult.stdout.trim();
    architectures = lipoResult.stdout.trim();
  } catch (error) {
    throw new Error(`Could not verify the downloaded Sky architecture: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  if (!/^Mach-O 64-bit executable arm64\b/.test(description) || architectures !== 'arm64') {
    throw new Error('The downloaded Sky executable is not a darwin-arm64 Mach-O.');
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await open(file, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(executable: string, replacement: string): Promise<string> {
  const stats = await lstat(executable);
  if (!stats.isFile()) throw new Error('The running Sky executable is not a regular file.');
  const directory = path.dirname(executable);
  const stage = path.join(directory, `.sky.update.${process.pid}.${randomUUID()}.tmp`);
  const backup = path.join(directory, `.sky.update.${process.pid}.${randomUUID()}.backup`);
  let replaced = false;
  try {
    await copyFile(replacement, stage, constants.COPYFILE_EXCL);
    await chmod(stage, 0o755);
    await syncFile(stage);
    await link(executable, backup);
    await syncFile(backup);
    await rename(stage, executable);
    replaced = true;
    return backup;
  } finally {
    await rm(stage, { force: true });
    if (!replaced) await rm(backup, { force: true });
  }
}

async function rollbackReplacement(
  executable: string,
  backup: string,
  updateError: unknown,
): Promise<never> {
  try {
    await rename(backup, executable);
  } catch (rollbackError) {
    throw new Error(
      `Sky update failed and the previous executable could not be restored from ${backup}: ${errorMessage(rollbackError)}`,
      { cause: rollbackError },
    );
  }

  let restartError: unknown;
  try {
    const status = await restartLaunchAgent();
    const daemonVersion = status.control.status?.productVersion;
    if (daemonVersion !== PRODUCT_VERSION) {
      throw new Error(`the restored daemon reported version ${daemonVersion ?? 'unknown'}`);
    }
  } catch (error) {
    restartError = error;
  }

  const restartDetail = restartError
    ? ` The previous executable was restored, but its daemon could not be restarted: ${errorMessage(restartError)}`
    : ' The previous executable and daemon were restored.';
  throw new Error(`Sky update failed after replacement: ${errorMessage(updateError)}${restartDetail}`, {
    cause: updateError,
  });
}

export async function updateStandalone(
  options: { releaseApiUrl?: string } = {},
): Promise<UpdateResult> {
  if (RUNTIME_KIND !== 'standalone') {
    throw new Error(
      'sky update is available only in a standalone installation. Update this Node.js development runtime through its package or checkout instead.',
    );
  }

  const release = await fetchLatestRelease(options.releaseApiUrl ?? DEFAULT_RELEASE_API_URL);
  if (release.version === PRODUCT_VERSION) return { changed: false, version: PRODUCT_VERSION };

  const archiveName = `sky-${release.version}-darwin-arm64.tar.gz`;
  const checksumName = `${archiveName}.sha256`;
  const archiveAsset = requireAsset(release, archiveName);
  const checksumAsset = requireAsset(release, checksumName);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'sky-update-'));
  try {
    const archivePath = path.join(temporaryDirectory, archiveName);
    const checksumPath = path.join(temporaryDirectory, checksumName);
    await download(archiveAsset, archivePath, MAX_ARCHIVE_BYTES);
    await download(checksumAsset, checksumPath, MAX_CHECKSUM_BYTES);
    await verifyChecksum(archivePath, checksumPath, archiveName);
    const replacement = await extractExecutable(archivePath, temporaryDirectory);
    await verifyExecutableArchitecture(replacement);
    await verifyExecutableVersion(replacement, release.version);
    const backup = await atomicReplace(process.execPath, replacement);
    try {
      const status = await restartLaunchAgent();
      const daemonVersion = status.control.status?.productVersion;
      if (daemonVersion !== release.version) {
        throw new Error(
          `Restarted Sky daemon reported version ${daemonVersion ?? 'unknown'} instead of ${release.version}.`,
        );
      }
      await rm(backup, { force: true });
    } catch (error) {
      await rollbackReplacement(process.execPath, backup, error);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return {
    changed: true,
    previousVersion: PRODUCT_VERSION,
    version: release.version,
  };
}

export const updateCommand = new Command('update')
  .description('Update a standalone Sky installation and restart its daemon')
  .option(
    '--release-api-url <url>',
    'Use an alternate latest-release API endpoint',
    DEFAULT_RELEASE_API_URL,
  )
  .action(async (options: { releaseApiUrl: string }) => {
    const result = await updateStandalone({ releaseApiUrl: options.releaseApiUrl });
    if (!result.changed) {
      console.log(`Sky ${result.version} is already up to date.`);
      return;
    }
    console.log(`Updated Sky from ${result.previousVersion} to ${result.version}.`);
  });
