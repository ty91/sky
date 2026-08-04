import { readFileSync } from 'node:fs';

declare const SKY_BUILD_VERSION: string | undefined;

function packageVersion(): string {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return version;
}

export function resolveProductVersion(buildVersion: string | undefined): string {
  return buildVersion ?? packageVersion();
}

const buildVersion =
  typeof SKY_BUILD_VERSION === 'undefined' ? undefined : SKY_BUILD_VERSION;

export const PRODUCT_VERSION = resolveProductVersion(buildVersion);
