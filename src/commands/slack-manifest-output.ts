import { spawn } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import {
  buildSlackAppManifest,
  serializeSlackAppManifest,
  slackAppCreateUrl,
  SLACK_APP_CONSOLE_URL,
  SLACK_APP_NAME,
} from '../slack/manifest.js';

export type SlackManifestReport = {
  manifest: ReturnType<typeof buildSlackAppManifest>;
  createUrl: string;
  consoleUrl: string;
};

export function slackManifestReport(): SlackManifestReport {
  const manifest = buildSlackAppManifest();
  return {
    manifest,
    createUrl: slackAppCreateUrl(manifest),
    consoleUrl: SLACK_APP_CONSOLE_URL,
  };
}

/**
 * Opening a browser is best effort. A failure must never fail the caller: the
 * URL is always printed first so the user can paste it manually.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [url], { stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export function canPromptInteractively(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export function printSlackAppSetupSteps(report: SlackManifestReport): void {
  console.log(`Create the ${SLACK_APP_NAME} Slack app from its manifest:`);
  console.log('  1. Open the link below and confirm "Create".');
  console.log('  2. Install the app to your workspace.');
  console.log('  3. Copy the bot token (xoxb-) from OAuth & Permissions and the app token (xapp-)');
  console.log('     from Basic Information > App-Level Tokens, with the connections:write scope.');
  console.log('');
  console.log(report.createUrl);
  console.log('');
}

export function printSlackAppUpdateSteps(report: SlackManifestReport): void {
  console.log('To update an app that already exists, do not create a new one.');
  console.log(`Open ${report.consoleUrl}, pick the app, go to Features > App Manifest, replace the`);
  console.log('manifest with the JSON below, then reinstall the app to the workspace.');
  console.log('Reinstalling issues a new bot token, so run `sky init` again to store it.');
  console.log('');
}

export function printSlackManifestJson(report: SlackManifestReport): void {
  stdout.write(serializeSlackAppManifest(report.manifest));
}

export function printSlackVerificationLimits(): void {
  console.log('Sky verifies the granted bot scopes and, through the app token, that Socket Mode is');
  console.log('on. It cannot read back your event subscriptions or the agent view, so re-apply the');
  console.log('whole manifest rather than adding fields one at a time.');
}
