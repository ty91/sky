import { Command } from 'commander';
import {
  canPromptInteractively,
  openInBrowser,
  printSlackAppSetupSteps,
  printSlackAppUpdateSteps,
  printSlackManifestJson,
  printSlackVerificationLimits,
  slackManifestReport,
} from './slack-manifest-output.js';

const manifestCommand = new Command('manifest')
  .description('Print the Sky Slack app manifest and its create-from-manifest link')
  .option('--json', 'Print the manifest and links as one stable JSON document')
  .option('--open', 'Open the create-from-manifest link in the default browser')
  .action(async (options: { json?: boolean; open?: boolean }) => {
    const report = slackManifestReport();
    if (options.json === true) {
      console.log(JSON.stringify({ ok: true, ...report }, null, 2));
      return;
    }

    printSlackAppSetupSteps(report);
    printSlackAppUpdateSteps(report);
    printSlackManifestJson(report);
    console.log('');
    printSlackVerificationLimits();

    // --open is the only way to reach a browser here; the bare command stays
    // pipe-safe so `sky slack manifest --json` and shell redirection behave.
    if (options.open === true) {
      const opened = await openInBrowser(report.createUrl);
      console.log('');
      console.log(
        opened
          ? 'Opened the create-from-manifest link in your browser.'
          : 'Could not open a browser. Use the link above.',
      );
    } else if (canPromptInteractively()) {
      console.log('');
      console.log('Run `sky slack manifest --open` to open the link directly.');
    }
  });

export const slackCommand = new Command('slack')
  .description('Slack app setup helpers')
  .addCommand(manifestCommand);
