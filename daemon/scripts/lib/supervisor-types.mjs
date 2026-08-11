// The supervisor predicate, for scripts that measure agent trees (KAN-276).
//
// agent-cost.ts requires every caller to say which workspace types supervise,
// and deliberately offers no default — a module-level import of
// registry.ts's `isSupervisorType` answers `false` for everything in a process
// that has not booted the registry, which would silently put epic and story
// trees back into the per-task-agent divisor. That is the defect KAN-276 fixed,
// so the type system asks instead of assuming.
//
// A script cannot boot the registry cheaply: registering the Atlassian
// integration wants a credential, an issue-type lookup and the enablement store
// on disk, and a type that is switched off is never registered at all — which
// would make a *disabled* integration look like a fleet with no supervisors in
// it, quietly re-contaminating the sample.
//
// So this reads the same declarations the registry would have read, from the
// same function that supplies them, without booting anything:
// `atlassianWorkspaceTypes()` returns the `WorkspaceTypeConfig` list with its
// `supervisor` flags, and the lookup it takes is only used by key extraction.
// Adding a third supervising type to that list reaches this predicate for free,
// which a hardcoded `new Set(['epic', 'story'])` here would not — and a second
// copy of that rule is exactly what registry.ts declines to export its set to
// prevent.

import * as path from 'path';

/**
 * `(type) => boolean`, plus the set it answers from so a script can print what
 * it is holding out. `distDir` is the built daemon, which every caller already
 * resolves for its own imports.
 */
export async function supervisorPredicate(distDir) {
  const { atlassianWorkspaceTypes } = await import(
    path.join(distDir, 'integrations', 'atlassian-integration.js')
  );
  const types = new Set(
    atlassianWorkspaceTypes()
      .filter((t) => t.supervisor === true)
      .map((t) => t.type)
  );
  if (types.size === 0) {
    // Not a stylistic complaint. An empty set means every tree is chargeable,
    // which is the contaminated behaviour this module exists to prevent, and a
    // script that measured under it would print a confident wrong number.
    throw new Error(
      'no workspace type declares supervisor: true — refusing to measure, because ' +
        'an empty supervisor set puts epic and story trees back in the task-agent divisor'
    );
  }
  return { isSupervisor: (type) => types.has(type), supervisorTypes: types };
}
