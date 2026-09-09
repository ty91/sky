import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { Command } from 'commander';
import { createSkyHome } from '../sky-home.js';
import { issueAdminLogin } from '../skyd/control-uds.js';
import type { AdminLoginGrant } from '../skyd/control.js';

const execFileAsync = promisify(execFile);

type AdminOptions = {
  open?: boolean;
};

function urlFor(host: string, port: number): URL {
  const url = new URL('http://localhost/');
  url.hostname = host;
  url.port = String(port);
  return url;
}

function localHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1';
  if (bindHost === '::') return '::1';
  return bindHost;
}

function remoteHost(bindHost: string): string {
  return bindHost === '0.0.0.0' || bindHost === '::' ? os.hostname() : bindHost;
}

function manualLogin(grant: AdminLoginGrant): void {
  console.log(`Admin URL: ${urlFor(remoteHost(grant.host), grant.port)}`);
  console.log(`Login token: ${grant.token}`);
  console.log(`Expires at: ${grant.expiresAt}`);
}

async function openBrowser(url: string): Promise<void> {
  const configuredBrowser = process.env.BROWSER?.trim();
  if (configuredBrowser) {
    await execFileAsync(configuredBrowser, [url]);
    return;
  }
  if (process.platform === 'darwin') {
    await execFileAsync('open', [url]);
    return;
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/c', 'start', '', url]);
    return;
  }
  await execFileAsync('xdg-open', [url]);
}

async function runAdmin(options: AdminOptions): Promise<void> {
  let grant: AdminLoginGrant | undefined;
  try {
    const home = createSkyHome();
    grant = await issueAdminLogin(home.socketFile);
    if (options.open === false) {
      manualLogin(grant);
      return;
    }

    const url = urlFor(localHost(grant.host), grant.port);
    url.hash = new URLSearchParams({ token: grant.token }).toString();
    await openBrowser(url.toString());
    console.log('Opened Sky Admin in your browser.');
  } catch {
    if (grant) {
      console.error('error: Could not open Sky Admin. Run `sky admin --no-open` to sign in manually.');
    } else {
      console.error('error: Could not request an admin login. Is skyd running?');
    }
    process.exitCode = 1;
  }
}

export const adminCommand = new Command('admin')
  .description('Open the authenticated Sky Admin gateway')
  .option('--no-open', 'Print a remote URL and one-time login token instead of opening a browser')
  .action(runAdmin);
