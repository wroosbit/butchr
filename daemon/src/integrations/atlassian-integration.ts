import { WorkspaceTypeConfig } from '../types.js';
import { CredentialAdapter, Integration, McpServerDefinitions } from './integration.js';
import {
  PRIORITY_EPIC,
  PRIORITY_STORY,
  PRIORITY_TASK
} from '../priority.js';
import { which } from '../env.js';

// Atlassian as Butchr's first integration: one credential, one mcp-remote
// endpoint, and the workspace types it contributes — Jira's `task`, `story`
// and `epic` today, Confluence's later (KAN-90). The unit is the *vendor*,
// because that is what the credential and the MCP server belong to; Jira and
// Confluence are two products behind one of each.
//
// All of this was previously `registerDefaults()` and two module constants in
// registry.ts, plus one arm of the hardcoded if-chain in launchers.ts. It is
// moved, not rewritten: the configs, the mapping table, the fallback and the
// server definition are the same objects with the same comments, so a diff of
// this file against the old registry and launcher is a relocation. What
// changed is *where* it lives — the registry no longer knows the word "Jira",
// the refinement lookup is supplied by this module rather than injected into
// the registry, and the Atlassian server's definition is held by the thing
// that knows whose it is.
//
// `../jira.ts` is *not* renamed and does not move: it is the Jira REST client
// and issue-type service, still Jira-specific, and this module wires to it.

/** Asks Jira for an issue's type name. Must never throw; null means unknown. */
export type IssueTypeLookup = (key: string) => Promise<string | null>;

/**
 * Jira issue-type name → workspace type.
 *
 * Data, not branching: adding a workspace type for Bug later is a line here
 * plus a `register` call, with no control flow to re-read. Keys are compared
 * lower-cased because Jira's type names are display strings and a renamed or
 * localised type should not silently change behaviour by casing alone.
 */
const WORKSPACE_TYPE_BY_JIRA_ISSUE_TYPE: Record<string, string> = {
  epic: 'epic',
  story: 'story'
};

/**
 * Everything else — Task, Bug, Subtask, an unrecognised custom type, or a
 * lookup that could not be performed at all — is a `task` workspace. This
 * constant is the degradation guarantee in one place: whatever goes wrong,
 * resolution lands here.
 */
export const DEFAULT_JIRA_WORKSPACE_TYPE = 'task';

export function workspaceTypeForJiraIssueType(issueTypeName: string | null): string {
  if (!issueTypeName) return DEFAULT_JIRA_WORKSPACE_TYPE;
  return (
    WORKSPACE_TYPE_BY_JIRA_ISSUE_TYPE[issueTypeName.trim().toLowerCase()] ??
    DEFAULT_JIRA_WORKSPACE_TYPE
  );
}

/**
 * The MCP server Atlassian's agents get.
 *
 * The official Atlassian MCP is a remote endpoint; mcp-remote bridges it to
 * stdio clients (OAuth browser flow on first use) — so this definition carries
 * no token, and none should be invented for it.
 *
 * Absolute commands: the agent spawns these with the *pane's* PATH, which can
 * be thinner than ours (a login-started herdr server has no nvm) and resolve
 * `node`/`npx` to an ancient system install. The daemon rewrites this file on
 * every activation, so the baked paths never go stale — which is why this is
 * resolved on every call rather than captured at registration.
 */
export function atlassianMcpServers(): McpServerDefinitions {
  return {
    atlassian: {
      command: which('npx') ?? 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp']
    }
  };
}

export interface AtlassianIntegrationOptions {
  /**
   * Optional on purpose: with no lookup installed the daemon behaves exactly
   * as it did before Jira access existed — every issue URL resolves to `task`.
   * That is also the fallback path, so the un-configured case is not a special
   * case, it is the same code.
   */
  issueTypeLookup?: IssueTypeLookup;
  /**
   * The credential this integration stores. `JiraIssueTypeService` satisfies
   * `CredentialAdapter` as it stands — status / storageTarget / setCredential /
   * clearCredential are the methods it already had — so the daemon passes the
   * same service it passes the lookup, and nothing about credential storage
   * moved.
   */
  credential?: CredentialAdapter;
}

/**
 * The workspace types this integration contributes — Jira's three, exactly as
 * `registerDefaults()` registered them and in the same order.
 *
 * The refinement hook closes over the caller's lookup and does what
 * `resolve()` used to do inline: ask Jira, then map the answer — including the
 * null answer — through `workspaceTypeForJiraIssueType`. The registry keeps
 * the try/catch around it, so a lookup that breaks its "never throw" contract
 * still lands on `task` rather than failing an activation.
 */
export function atlassianWorkspaceTypes(lookup?: IssueTypeLookup): WorkspaceTypeConfig[] {
  return [
    {
      type: 'task',
      name: 'Jira Task',
      urlPatterns: [
        /https?:\/\/[^\/]+\/browse\/([A-Z0-9]+-\d+)/i,
        /https?:\/\/[^\/]+\/jira\/[^\/]+\/projects\/[^\/]+\/issues\/([A-Z0-9]+-\d+)/i,
        /[\?&]selectedIssue=([A-Z0-9]+-\d+)/i
      ],
      keyExtractor: (url: string) => {
        const match = url.match(/\/browse\/([A-Z0-9]+-\d+)/i) ||
                      url.match(/\/issues\/([A-Z0-9]+-\d+)/i) ||
                      url.match(/[\?&]selectedIssue=([A-Z0-9]+-\d+)/i);
        return match ? match[1].toUpperCase() : null;
      },
      promptTemplateFile: 'prompts/task.md',
      priority: PRIORITY_TASK,
      // Every Jira issue URL matches this type first; which workspace type it
      // *actually* becomes is then decided by the issue's type in Jira.
      // Without a lookup there is nothing to ask, and the hook is left off —
      // the registry then returns the URL match, which is this same `task`.
      ...(lookup
        ? {
            refine: async (key: string) =>
              workspaceTypeForJiraIssueType(await lookup(key))
          }
        : {})
    },

    // Deliberately pattern-less. A Story's URL is byte-identical to a Task's,
    // so there is nothing to match on — this type is reached only by refining
    // a `task` URL match against the issue's real type in Jira, or by an
    // explicit activate_by_key. Giving it patterns would make it compete with
    // `task` on identical URLs and reintroduce the ambiguity this exists to
    // resolve.
    {
      type: 'story',
      name: 'Jira Story',
      urlPatterns: [],
      keyExtractor: () => null,
      promptTemplateFile: 'prompts/story.md',
      // Above `task` because a story agent decomposes a story into the tasks
      // that task agents execute: it is upstream of them, so taking a task's
      // slot to run a story unblocks the thing that generates more work.
      priority: PRIORITY_STORY,
      // A story agent staffs its tasks rather than doing them.
      supervisor: true
    },

    // Pattern-less for the same reason as `story`: an Epic's URL is
    // byte-identical to a Task's, so there is nothing to match on — this type
    // is reached only by refining a `task` URL match against the issue's real
    // type in Jira, or by an explicit activate_by_key. Giving it patterns
    // would make it compete with `task` on identical URLs.
    {
      type: 'epic',
      name: 'Jira Epic',
      urlPatterns: [],
      keyExtractor: () => null,
      promptTemplateFile: 'prompts/epic.md',
      // The top of the scale: an epic agent supervises the stories under it,
      // so nothing outranks it by construction. See priority.ts.
      priority: PRIORITY_EPIC,
      // An epic agent staffs its stories rather than doing them.
      supervisor: true
    }
  ];
}

/**
 * Atlassian, as one pluggable unit: its workspace types, its credential, and
 * the MCP server its agents get.
 */
export function createAtlassianIntegration(
  options: AtlassianIntegrationOptions = {}
): Integration {
  return {
    // The concept, the module and the display name are "Atlassian"; the
    // persisted and on-the-wire identity stays `jira`, deliberately. KAN-86
    // chose these spellings — `jira-credential.json`, keyring `account jira` —
    // so that parametrizing the credential store needed no migration, and
    // KAN-87's shipped settings UI addresses this row as `id: 'jira'`. Renaming
    // the identity would buy nothing a user can see and cost a migration of a
    // live credential plus a break in a deployed surface. If it is ever
    // renamed, the credential file, the keyring attributes, the
    // `integration: 'jira'` action arguments and the UI must move together.
    id: 'jira',
    name: 'Atlassian',
    // Off until turned on; the registry replaces this with the persisted
    // decision, and an install that already has a configured credential
    // migrates as enabled rather than being silently switched off. See
    // enablement.ts.
    enabled: false,
    workspaceTypes: atlassianWorkspaceTypes(options.issueTypeLookup),
    mcpServers: atlassianMcpServers,
    ...(options.credential ? { credential: options.credential } : {})
  };
}
