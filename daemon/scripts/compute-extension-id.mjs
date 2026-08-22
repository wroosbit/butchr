#!/usr/bin/env node
// compute-extension-id — prints the ID Chrome will give an unpacked extension
// loaded from a given directory, without loading it.
//
// WHY THIS EXISTS: docs/SETUP.md stated that an unpacked extension's ID "is
// derived from the load path" and then did not give the derivation, so the
// reader had to load the extension in Chrome and copy the ID off its card
// before the native-messaging host could be registered. That ordering is the
// only reason the host manifest arrived after the extension did, and therefore
// the only reason the extension had to be reloaded afterwards. The derivation
// was never secret; it was only unwritten.
//
// THE DERIVATION: sha256 of the **absolute load path**, first 32 hex nibbles,
// each mapped 0-15 -> a-p. That is Chrome's own scheme for unpacked
// extensions, and it is why the ID differs on every machine and changes when
// the clone moves.
//
// BOUNDARY — this does not describe every extension ID. A packed or Chrome Web
// Store extension takes its ID from the signing key in its .crx, not from any
// path, so nothing here computes or predicts one. This is the unpacked case
// only, which is the case docs/SETUP.md installs.
//
// No dependencies and no build step: it runs against a clone nobody has built
// yet, because computing the ID is what lets you register the host *before*
// building anything into Chrome.
//
// Exit codes: 0 = an ID was printed, 1 = the arguments were unusable.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_DIR = path.join(REPO, 'extension', 'dist');

/**
 * Chrome's unpacked-extension ID: sha256 of the absolute path, first 32
 * nibbles, base-16 digits mapped onto the letters a-p.
 */
function extensionIdForPath(absolutePath) {
  const digest = createHash('sha256').update(absolutePath, 'utf8').digest('hex');
  return digest
    .slice(0, 32)
    .split('')
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + parseInt(nibble, 16)))
    .join('');
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node daemon/scripts/compute-extension-id.mjs [load-path]

Prints the ID Chrome gives an unpacked extension loaded from <load-path>.
With no argument, uses this clone's built output directory:

  ${DEFAULT_DIR}

The path is the directory you select in "Load unpacked" — the built output
(extension/dist), not the repo root and not extension/.

Feed the result to the native-messaging host installer:

  daemon/scripts/install-native-host.sh "$(node daemon/scripts/compute-extension-id.mjs)"
`);
  process.exit(0);
}

if (args.length > 1) {
  console.error(`Error: expected at most one path, got ${args.length}: ${args.join(' ')}`);
  console.error('Run with --help for usage.');
  process.exit(1);
}

// `path.resolve` makes the path absolute and normalises it — a trailing slash
// or a `..` in what you typed is not a different extension. It deliberately
// does NOT resolve symlinks: Chrome hashes the path it was handed, so guessing
// on the reader's behalf could print an ID Chrome never assigns. Where the two
// differ we say so rather than choose, below.
const loadPath = path.resolve(args[0] ?? DEFAULT_DIR);
const id = extensionIdForPath(loadPath);

// stdout carries the ID and nothing else, so `$(...)` around this call is safe.
// Everything advisory goes to stderr.
console.log(id);

let realPath = null;
try {
  realPath = fs.realpathSync(loadPath);
} catch {
  console.error(`Note: ${loadPath} does not exist yet. The ID above is still what Chrome`);
  console.error('      would assign to that path — build the extension, then load it there.');
}

if (realPath !== null && realPath !== loadPath) {
  console.error(`Note: ${loadPath}`);
  console.error(`      resolves through a symlink to ${realPath}.`);
  console.error('      Chrome hashes whichever of the two you actually select in "Load');
  console.error(`      unpacked". That other path would be ${extensionIdForPath(realPath)}.`);
  console.error('      If the card at chrome://extensions disagrees with the ID above, it');
  console.error('      is because you selected the other one.');
}

if (realPath !== null && !fs.existsSync(path.join(loadPath, 'manifest.json'))) {
  console.error(`Note: ${loadPath} holds no manifest.json, so Chrome will refuse to load it.`);
  console.error('      The ID above is correct for the path; the path is not an extension yet.');
}
