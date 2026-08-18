/**
 * KAN-501: what a clipped answer can honestly tell its caller to do next.
 *
 * THE DEFECT THIS EXISTS TO END. `mcp-response-budget.ts` replaced an
 * over-budget field with a stub carrying a recovery recipe, and the recipe was
 * built from the calling tool's **name**:
 *
 *     readWith: "atlassian_get_issue_comments({ section: 'body' })"
 *
 * There is no `section` parameter on that tool, or on any of the other
 * forty-odd this server carries. Exactly one — `butchr_list_agents` — advertises
 * one and honours it, and the recipe was written for that tool and then emitted
 * for every tool. Measured on the fleet's daemon by `task/KAN-420` (2026-08-16),
 * `epic/KAN-39` (2026-08-17) and `epic/KAN-203` (2026-08-18): the printed call
 * cannot be typed, and calling it with `section` anyway returns the identical
 * clipped answer, because the parameter is not in the schema to be refused.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN A FUNCTION IN `mcp.ts`. Because a check
 * has to be able to import it. `mcp.ts` starts an MCP server on import, so
 * anything living there can only be tested by a copy of itself living in the
 * test — which is the KAN-145 hole exactly: two artifacts that agree with each
 * other and neither of which is what runs. `verify-clip-recipes-are-executable.mjs`
 * imports THIS file and checks what it emits against the schemas the tools
 * actually advertise.
 *
 * WHAT NOTHING HERE RETURNS: a `call` recovery. No proxied operation has a
 * parameter that returns one field of a response on its own, so there is no
 * call to print — and printing one anyway is the whole ticket.
 */
import { operationByTool } from './atlassian-proxy.js';
import { ldOperationByTool } from './launchdarkly-proxy.js';
/**
 * The parameters a tool actually advertises, or `null` where this process
 * cannot say (KAN-501).
 *
 * READ OFF THE SAME OBJECT THE CLIENT IS ADVERTISED, which is the whole
 * argument for this function existing rather than a list of parameter names
 * kept beside it. The defect this file is fixing was a recipe *derived from a
 * tool's name* — `<tool>({ section: '<field>' })` — which was true of one tool
 * and false of the forty-odd proxied ones. A second hand-maintained list would
 * have been the same mistake with an extra step: correct on the day it was
 * written and silently wrong the first time an operation's schema moved.
 *
 * `null` for the daemon-native tools, whose schemas are literals inside the
 * listing handler below rather than a table this can index. That is not a gap
 * that matters: `null` means *say nothing about parameters*, and a stub that
 * names no parameter cannot name a wrong one.
 */
export function advertisedParams(tool) {
    const op = operationByTool(tool) ?? ldOperationByTool(tool);
    if (!op)
        return null;
    const props = op.inputSchema?.properties;
    return props && typeof props === 'object' ? Object.keys(props) : null;
}
/**
 * Parameters that make a response *smaller* when a caller reaches for them.
 *
 * A FILTER OVER REAL PARAMETERS, NEVER A SOURCE OF THEM. Every name here is
 * intersected with what {@link advertisedParams} read off the tool's own
 * schema, so a name that is wrong, renamed or removed drops out rather than
 * being printed at somebody. That property is what makes a hand-written set
 * safe here and is why it must stay a filter: the moment it is used to *emit* a
 * name, this is the original defect again.
 */
export const NARROWING_PARAMS = new Set(['maxResults', 'limit', 'startAt', 'cursor', 'fields', 'bodyFormat']);
/**
 * What a clipped answer can honestly offer a caller of this tool.
 *
 * NOTE WHAT IT NEVER RETURNS: a `call`. No proxied operation has a parameter
 * that returns one field of a response on its own, so there is no call to
 * print, and printing one anyway is the thing this ticket is about. What it
 * returns instead is a sentence naming the levers that exist — and, where the
 * answer is genuinely "none", saying that rather than implying otherwise.
 */
export function genericRecovery(tool, path) {
    const params = advertisedParams(tool);
    const levers = (params ?? []).filter((p) => NARROWING_PARAMS.has(p));
    if (levers.length === 0) {
        return {
            kind: 'none',
            why: `${tool} takes no parameter that returns "${path}" on its own, and none that ` +
                'narrows this answer. What is here is what this call can say.'
        };
    }
    return {
        kind: 'none',
        why: `${tool} has no parameter that returns "${path}" on its own. Ask for less with ` +
            `${levers.map((p) => `\`${p}\``).join(' or ')} — and note that a single entry can ` +
            'exceed the budget by itself, in which case no value of any of them returns it here.'
    };
}
