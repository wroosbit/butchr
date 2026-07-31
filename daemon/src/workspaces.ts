import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The one directory tree Butchr owns. Everything under it is disposable and
 * agent-managed; everything outside it belongs to the user. Workspace types
 * may point an agent's cwd elsewhere (`manage` runs in `~`), so this root is
 * what tells destructive and provisioning operations apart from safe ones.
 */
export const WORKSPACES_ROOT = path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');

/** Expand a leading `~` in a configured path. Anything else is left alone. */
export function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return target;
}

/**
 * A path with symlinks resolved as far as the filesystem allows. `realpathSync`
 * throws on anything that does not exist yet, so this walks up to the deepest
 * existing ancestor, resolves that, and re-appends the missing tail — a guard
 * has to give an answer for a directory that was already deleted, and a
 * workspace whose name is a symlink out of the tree must not resolve back
 * inside it.
 */
export function realResolve(target: string): string {
  let head = path.resolve(expandHome(target));
  const tail: string[] = [];

  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      // Filesystem root, and still nothing exists: nothing left to resolve.
      if (parent === head) return path.join(head, ...tail);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Is this directory *strictly* inside the workspaces root — a workspace rather
 * than the root itself, the user's home, or anywhere else? Two operations hang
 * off this answer, and both are dangerous when it is wrong:
 *
 *   - reset, which would otherwise `rm -rf` a `manage` agent's `~`;
 *   - claude provisioning, which writes `bypassPermissions` into
 *     `.claude/settings.local.json` and records folder trust in `~/.claude.json`
 *     — where the trust check walks parent directories, so trusting `~` would
 *     silently trust the user's entire home tree for their own sessions too.
 */
export function isInsideWorkspacesRoot(dir: string): boolean {
  const root = realResolve(WORKSPACES_ROOT);
  const target = realResolve(dir);
  return target !== root && target.startsWith(root + path.sep);
}

/**
 * Where a workspace's agent runs: the type's configured `workDir` when it has
 * one, else the per-key directory under the workspaces root. Reset and spawn
 * must agree on this, or reset would judge (and delete) a directory the agent
 * is not even running in.
 */
export function resolveWorkDir(type: string, key: string, configuredWorkDir?: string): string {
  const configured = configuredWorkDir?.trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(WORKSPACES_ROOT, type, key.toLowerCase());
}
