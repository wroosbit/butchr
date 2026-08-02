import { WorkspaceTypeConfig } from './types.js';
import {
  DEFAULT_WORKSPACE_PRIORITY,
  PRIORITY_EPIC,
  PRIORITY_STORY,
  PRIORITY_TASK
} from './priority.js';

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
 * Workspace types that hand work out rather than doing it: an epic agent
 * staffs its stories, a story agent staffs its tasks.
 *
 * Two callers read this set, and it lives here because this is where workspace
 * types are defined. The capacity model exempts supervisors from the cap —
 * see the header of capacity.ts for the argument. And the fleet UI's
 * stronger Off confirmation is driven by the `supervisor` DTO field in
 * router.ts, which is computed from this set so the UI never carries its own
 * copy of the rule.
 */
export const SUPERVISOR_WORKSPACE_TYPES: ReadonlySet<string> = new Set(['epic', 'story']);

export function isSupervisorType(type: string | null | undefined): boolean {
  return typeof type === 'string' && SUPERVISOR_WORKSPACE_TYPES.has(type);
}

/** Asks Jira for an issue's type name. Must never throw; null means unknown. */
export type IssueTypeLookup = (key: string) => Promise<string | null>;

export class WorkspaceRegistry {
  private types: Map<string, WorkspaceTypeConfig> = new Map();

  /**
   * Optional on purpose: with no lookup installed the registry behaves exactly
   * as it did before Jira access existed — every issue URL resolves to `task`.
   * That is also the fallback path, so the un-configured case is not a special
   * case, it is the same code.
   */
  constructor(private issueTypeLookup?: IssueTypeLookup) {
    this.registerDefaults();
  }

  private registerDefaults() {
    this.register({
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
      mcpServers: ['atlassian', 'butchr'],
      promptTemplateFile: 'prompts/task.md',
      priority: PRIORITY_TASK,
      // Every Jira issue URL matches this type first; which workspace type it
      // *actually* becomes is then decided by the issue's type in Jira.
      refineByJiraIssueType: true
    });

    // Deliberately pattern-less. A Story's URL is byte-identical to a Task's,
    // so there is nothing to match on — this type is reached only by refining
    // a `task` URL match against the issue's real type in Jira, or by an
    // explicit activate_by_key. Giving it patterns would make it compete with
    // `task` on identical URLs and reintroduce the ambiguity this exists to
    // resolve.
    this.register({
      type: 'story',
      name: 'Jira Story',
      urlPatterns: [],
      keyExtractor: () => null,
      mcpServers: ['atlassian', 'butchr'],
      promptTemplateFile: 'prompts/story.md',
      // Above `task` because a story agent decomposes a story into the tasks
      // that task agents execute: it is upstream of them, so taking a task's
      // slot to run a story unblocks the thing that generates more work.
      priority: PRIORITY_STORY
    });

    // Pattern-less for the same reason as `story`: an Epic's URL is
    // byte-identical to a Task's, so there is nothing to match on — this type
    // is reached only by refining a `task` URL match against the issue's real
    // type in Jira, or by an explicit activate_by_key. Giving it patterns
    // would make it compete with `task` on identical URLs.
    this.register({
      type: 'epic',
      name: 'Jira Epic',
      urlPatterns: [],
      keyExtractor: () => null,
      mcpServers: ['atlassian', 'butchr'],
      promptTemplateFile: 'prompts/epic.md',
      // The top of the scale: an epic agent supervises the stories under it,
      // so nothing outranks it by construction. See priority.ts.
      priority: PRIORITY_EPIC
    });
  }

  /**
   * What a workspace type outranks. Unregistered types get the floor — see
   * DEFAULT_WORKSPACE_PRIORITY for why that is the safe direction — and this is
   * the only place that fallback is applied, so a caller cannot accidentally
   * pick a different one.
   */
  public priorityFor(type: string | null | undefined): number {
    if (typeof type !== 'string') return DEFAULT_WORKSPACE_PRIORITY;
    return this.types.get(type)?.priority ?? DEFAULT_WORKSPACE_PRIORITY;
  }

  public register(config: WorkspaceTypeConfig) {
    this.types.set(config.type, config);
  }

  public get(type: string): WorkspaceTypeConfig | undefined {
    return this.types.get(type);
  }

  /** Pure URL-pattern matching — the original, synchronous behaviour. */
  private match(url: string): { config: WorkspaceTypeConfig; key: string } | null {
    for (const config of this.types.values()) {
      for (const pattern of config.urlPatterns) {
        if (pattern.test(url)) {
          const key = config.keyExtractor(url);
          if (key) {
            return { config, key };
          }
        }
      }
    }
    return null;
  }

  /**
   * URL → workspace type and key.
   *
   * Asynchronous because a Jira issue URL alone cannot say whether the issue
   * is a Task or a Story; that needs a question asked of Jira. The network
   * call is confined to the one branch that needs it, is cached, is bounded by
   * a hard timeout, and answers null on any failure — so this resolves to
   * `task` and activation proceeds normally whenever Jira is unavailable.
   */
  public async resolve(
    url: string
  ): Promise<{ config: WorkspaceTypeConfig; key: string } | null> {
    const matched = this.match(url);
    if (!matched) return null;
    if (!matched.config.refineByJiraIssueType || !this.issueTypeLookup) return matched;

    let issueTypeName: string | null;
    try {
      issueTypeName = await this.issueTypeLookup(matched.key);
    } catch {
      // The lookup's contract is "never throw; null means unknown", but the
      // degradation guarantee must not depend on every injected lookup
      // honouring it: a throwing lookup is a lookup that could not be
      // performed, and lands on the same null as any other failure.
      issueTypeName = null;
    }
    const workspaceType = workspaceTypeForJiraIssueType(issueTypeName);
    if (workspaceType === matched.config.type) return matched;

    const refined = this.types.get(workspaceType);
    // A mapping naming an unregistered type is a bug, but not one worth
    // failing an activation over — keep the URL-matched type.
    return refined ? { config: refined, key: matched.key } : matched;
  }
}
