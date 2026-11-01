import { readFileSync } from 'node:fs';

/** Works from compiled dist in both the repository and the installed archive. */
export const SERVER_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
