import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const [tagArgument] = process.argv.slice(2).filter((argument) => argument !== '--');
const tag = tagArgument ?? process.env.GITHUB_REF_NAME;
const expectedTag = `v${manifest.version}`;

if (!tag) {
  console.error('Release tag is required as an argument or GITHUB_REF_NAME.');
  process.exit(1);
}

if (tag !== expectedTag) {
  console.error(`Release tag ${tag} does not match package version ${manifest.version}.`);
  process.exit(1);
}

console.log(`${tag} matches ${manifest.name}@${manifest.version}.`);
