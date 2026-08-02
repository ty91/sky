import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const stateFile = process.env.SKY_FAKE_LAUNCHCTL_STATE;

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return {
      loaded: false,
      pid: null,
      bootstrapCount: 0,
      bootoutCount: 0,
      kickstartCount: 0,
    };
  }
}

async function saveState(state) {
  await writeFile(stateFile, JSON.stringify(state));
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startDaemon(state, plistFile) {
  const plist = await readFile(plistFile, 'utf8');
  const failMatch = process.env.SKY_FAKE_FAIL_BOOTSTRAP_MATCH;
  if (failMatch && plist.includes(failMatch)) {
    process.stderr.write('injected bootstrap failure\n');
    process.exitCode = 5;
    return;
  }

  const child = spawn(process.execPath, [process.env.SKY_FAKE_DAEMON], {
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.unref();
  state.loaded = true;
  state.pid = child.pid;
  state.plistFile = plistFile;
  state.bootstrapCount += 1;
  await saveState(state);
}

const [command, ...args] = process.argv.slice(2);
const state = await readState();

if (command === 'print') {
  if (!state.loaded) {
    process.stderr.write('Could not find service\n');
    process.exitCode = 113;
  } else {
    process.stdout.write(`gui/test/com.ty91.skyd = {\n\tstate = running\n\tpid = ${state.pid}\n}\n`);
  }
} else if (command === 'bootstrap') {
  await startDaemon(state, args[1]);
} else if (command === 'bootout') {
  if (alive(state.pid)) process.kill(state.pid, 'SIGTERM');
  state.loaded = false;
  state.pid = null;
  state.bootoutCount += 1;
  await saveState(state);
} else if (command === 'kickstart') {
  if (!state.loaded) {
    process.stderr.write('service is not loaded\n');
    process.exitCode = 3;
  } else if (args.includes('-k')) {
    state.kickstartCount = (state.kickstartCount ?? 0) + 1;
    if (alive(state.pid)) process.kill(state.pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (alive(state.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await startDaemon(state, state.plistFile);
  }
} else {
  process.stderr.write(`unsupported fake launchctl command: ${command}\n`);
  process.exitCode = 2;
}
