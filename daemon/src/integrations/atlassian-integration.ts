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
// and `epic`, and Confluence's `confluence` (KAN-142). The unit is the
// *vendor*, because that is what the credential and the MCP server belong to;
// Jira and Confluence are two products behind one of each.
//
// Confluence is the honest test of that grouping, and it passed: adding a
// whole second product's workspaces is one more element in
// `atlassianWorkspaceTypes()` plus a prompt file. It declares no MCP server of
// its own and needs none — servers belong to the integration and attach to
// every agent it spawns, so `confluence` inherits `atlassian` by construction.
// That inheritance is the entire point of grouping the two products here.
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
 * The URL forms that are a Confluence **page**, and how the page id is read
 * out of each.
 *
 * One table rather than a pattern list beside a hand-written extractor: the
 * registry tests `urlPatterns` and then calls `keyExtractor`, and those two
 * answering from separate statements of the same fact is how a pattern comes
 * to match a URL whose key cannot be extracted. Both are derived from here.
 *
 * **The page id is the key.** It survives a retitle, an edit-versus-view, and
 * a draft being published — each of which moves the slug or the path segment
 * but never the id.
 *
 * Established from this site's real URLs, not guessed. Observed live on
 * wroosbit.atlassian.net:
 *
 *   - `getConfluencePage(196787).webUrl` →
 *     `/wiki/spaces/SD/pages/196787/Template+-+Decision+documentation`
 *   - a smart link inside a real page body → `/wiki/spaces/SD/pages/196761`,
 *     the same form with no slug
 *   - the human's own browser URL (KAN-90 comment 10385) →
 *     `/wiki/spaces/~7120206.../pages/edit-v2/65823?draftShareId=…`
 *
 * Two things that pattern has to survive, both real:
 *
 *   - **Personal-space keys begin with `~`** and run on for forty characters
 *     (`~712020619ec5ec2e92492f897991ccda318230`, confirmed live). A space
 *     matcher of `[A-Z]+` would break on every page in the space where the
 *     human's own drafts live, so the space segment is matched as "anything
 *     that is not a path or query delimiter" and never inspected.
 *   - **`/pages/` is not always followed by an id.** `/pages/edit-v2/<id>`
 *     means `/pages\/(\d+)/` misses the edit form, and `/pages\/([^\/]+)/`
 *     would claim the bare `/pages` listing and `edit-v2` itself as keys. Each
 *     form is therefore spelled out, and the digits are required.
 *
 * Everything else under `/wiki/` — space homes, the `/pages` listing,
 * whiteboards, databases, blog posts — is deliberately absent, so it resolves
 * to nothing. That is KAN-90's rule: a `/wiki/` URL that is not a supported
 * page must resolve to *nothing*, never degrade to `task`.
 *
 * Tiny links (`/wiki/x/<tinyId>`) are absent too, and unmatched is the honest
 * answer until KAN-143 lands: the tiny id is not a page id, so resolving one
 * needs a decode this table has nowhere to put a bare pattern. `pageIdFrom` is
 * the seam it will use — one more entry whose function decodes rather than
 * returning the capture verbatim.
 */
const CONFLUENCE_PAGE_URL_FORMS: Array<{
  pattern: RegExp;
  pageIdFrom: (match: RegExpMatchArray) => string | null;
}> = [
  // Canonical view URL, with or without the title slug after the id. The
  // trailing alternation is what stops `…/pages/1968` matching inside
  // `…/pages/196787`.
  {
    pattern: /https?:\/\/[^\/]+\/wiki\/spaces\/[^\/?#]+\/pages\/(\d+)(?:[\/?#]|$)/i,
    pageIdFrom: (match) => match[1]
  },
  // The editor. This is the form a human is looking at while writing the page
  // they want an agent on, so it matters more than its obscurity suggests.
  {
    pattern: /https?:\/\/[^\/]+\/wiki\/spaces\/[^\/?#]+\/pages\/edit-v2\/(\d+)(?:[\/?#]|$)/i,
    pageIdFrom: (match) => match[1]
  },
  // The unpublished draft, as the API hands it back. `draftId` is the page id.
  {
    pattern: /https?:\/\/[^\/]+\/wiki\/pages\/resumedraft\.action\?(?:[^#]*&)?draftId=(\d+)/i,
    pageIdFrom: (match) => match[1]
  }
];

/**
 * The workspace types this integration contributes — Jira's three, exactly as
 * `registerDefaults()` registered them and in the same order, and Confluence's
 * one after them.
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
    },

    // Confluence, and the whole of it: one type named after the entity, the
    // way `epic`/`story`/`task` are (human decision, KAN-90 comment 10313).
    // The name is load-bearing on disk — it is in the workspace path, the
    // agent name and the registry — so it is named for the thing that cannot
    // become wrong rather than for a job the page might turn out to have. A
    // page is a plan one week and a runbook the next; `prompts/confluence.md`
    // is where that difference is handled, not here.
    {
      type: 'confluence',
      name: 'Confluence Page',
      urlPatterns: CONFLUENCE_PAGE_URL_FORMS.map((form) => form.pattern),
      keyExtractor: (url: string) => {
        for (const { pattern, pageIdFrom } of CONFLUENCE_PAGE_URL_FORMS) {
          const match = url.match(pattern);
          if (match) return pageIdFrom(match);
        }
        return null;
      },
      promptTemplateFile: 'prompts/confluence.md',
      // A peer of the hierarchy, not a rung on it: a Confluence agent does the
      // work rather than handing it out, so it sits where work sits. Reusing
      // the existing constant rather than extending the scale is deliberate —
      // the scale means "what this type is to the others", and a page has no
      // standing relationship to a Jira epic at all.
      priority: PRIORITY_TASK
      // No `supervisor`: it staffs nobody (KAN-90 comment 10383).
      //
      // No `refine`: the URL carries the page id, so there is no question to
      // ask anyone. Jira's `task` needs one because an issue's URL cannot say
      // whether it is a Task or a Story; a page URL is not ambiguous about
      // what it is, and adding a hook here would put a network call on the
      // activation path for an answer already in hand.
      //
      // No MCP server, and none is missing: servers are the integration's and
      // attach to every agent it spawns, so this type gets `atlassian` — which
      // serves Confluence's tools as well as Jira's — without saying so.
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
