// Copies the Nimiq Mini App SDK's built files into public/ so the client can
// import it by relative path instead of pulling it from esm.sh at runtime.
// Runs on every `npm install` via the postinstall hook.
import { cpSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'node_modules', '@nimiq', 'mini-app-sdk', 'dist');
const dest = join(here, '..', 'public', 'vendor', 'nimiq-mini-app-sdk');

if (!existsSync(src)) {
  console.warn('[vendor-sdk] @nimiq/mini-app-sdk not found in node_modules — skipping');
  process.exit(0);
}

cpSync(src, dest, { recursive: true });
console.log(`[vendor-sdk] copied ${src} -> ${dest}`);
