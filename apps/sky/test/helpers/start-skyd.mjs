import { startSkyd as startProductSkyd } from '../../dist/skyd/app.js';

// Non-admin daemon tests must not contend for the production gateway's fixed TCP port.
export function startSkyd(options = {}) {
  return startProductSkyd({ ...options, admin: false });
}
