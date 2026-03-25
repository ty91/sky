import { createReadStream, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { LOG_FILE } from '../daemon.js';

export const logsCommand = new Command('logs')
  .description('Show daemon logs')
  .option('-f, --follow', 'follow log output in real-time')
  .action((opts: { follow?: boolean }) => {
    if (!existsSync(LOG_FILE)) {
      console.log('No log file found yet.');
      return;
    }

    if (opts.follow) {
      const tail = spawn('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
      process.on('SIGINT', () => {
        tail.kill();
        process.exit(0);
      });
      return;
    }

    const stream = createReadStream(LOG_FILE, 'utf8');
    stream.pipe(process.stdout);
  });
