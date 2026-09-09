import { createConfiguration } from './configuration.js';
import type { Settings } from './settings-schema.js';
import { createSkyHome, type SkyHome } from './sky-home.js';
export { parseSettings, type Settings } from './settings-schema.js';

export function loadSettings(
  options: { silent?: boolean; skyHome?: SkyHome } = {},
): Settings {
  const home = options.skyHome ?? createSkyHome();
  if (!options.silent) {
    console.log(`[startup] reading ${home.settingsFile}`);
  }
  return createConfiguration(home, { readOnly: true }).resolveRuntime().settings;
}
