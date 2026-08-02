import { Command } from 'commander';

export const restartCommand = new Command('restart')
  .description('Restart the daemon (available after graceful restart support lands)')
  .action(() => {
    console.error(
      'sky restart is temporarily unavailable while graceful launchd restart support is implemented. Use `sky stop` followed by `sky start` if an explicit non-graceful restart is acceptable.',
    );
    process.exitCode = 1;
  });
