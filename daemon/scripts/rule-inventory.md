# The operative-rule inventory

One line per entry in `daemon/scripts/verify-operative-rules-are-carried.mjs`.
That sweep reads this file and goes red when the two disagree **in either
direction** — an id declared here and absent there, or present there and
undeclared here.

## Why this file exists

KAN-241. In the sweep, the `RULES` and `RETIRED` entries **are** the checking,
so a dropped entry takes with it the assertion that would have noticed it was
dropped. The file still parses, `node --check` still passes, and the sweep
passes *harder* — there is one fewer assertion to satisfy. Nothing in this
repository said so.

That is not hypothetical. On 2026-08-08 `epic/KAN-39` resolved a real conflict
in that file, in that region, between two independently written entries **both
numbered `H-13`**: KAN-212's parent-epic rule on one side, KAN-250's storm
guards on the other. Taking either side would have dropped a live rule and left
a plausible-looking file with no duplicate left in it to notice. It was caught
by a person grepping on a hunch (`2a24912`), not by anything mechanical, and
there is no reason to expect a next time.

**There was no next time to wait for.** While the PR that added this file sat in
review, it happened again and reached `main`: KAN-242 (`4e7183a`) landed an entry
numbered `H-14`, the number KAN-212 had been given at `2a24912` two days
earlier. Both were live on the trunk at once. `node --check` passed, the sweep
passed, `verify-script-sweep` passed, and the PR was reviewed and approved — the
duplicate is visible in none of them. It was caught by this file's own
duplicate-id leg, at the moment its branch merged `main` in order to be merged
itself, and renumbered to `H-16`.

**Then it happened a second time, the same day, while that fix was in review.**
KAN-252 (`91b73a3`) landed an entry numbered `H-15`, colliding with KAN-262's
(`2a259d6`); renumbered to `H-17`. Four colliding entries in three incidents.
The first two were caught by a person reading, and neither of the last two was
caught by a person at all. That is the argument for this file, and it is no
longer hypothetical.

**It is also an argument this file cannot answer.** Detecting the collision is
not preventing it: the next free number is read off a file several branches are
extending at once, so two authors pick the same one and each is correct alone.
That is filed as [KAN-268](https://wroosbit.atlassian.net/browse/KAN-268). Until
it is decided, expect this leg to keep firing, and renumber per the `2a24912`
precedent — **the id stays with whichever landed first**, and every reference
outside the entry moves with it.

## Why it is a *separate* file, which is the whole of the design

**The accident this exists to catch is a conflict inside the script.** A merge
that collides in `RULES` does not touch this file, so the red arrives without
the editor ever being near the line that would silence it. Put the same list
inside the script and both halves land in one conflict hunk, where a single
`--ours` deletes the rule and its own alarm together.

## Why this will not simply be edited to match reality

It can be. Nothing here is enforcement, and a deliberate two-file edit defeats
it completely. What the shape buys is narrower and worth stating exactly:

- **A count would be the thing that rots.** `expect 15 entries` is silenced by a
  one-character edit that reads as bookkeeping. Silencing *this* file means
  deleting a line that says `H-14 — KAN-212 — every Story and Task filed
  carries a parent epic`, which reads as what it is: deleting a rule.
- **The failure message asks for the opposite edit.** It names the id, the
  ticket that introduced it, and says restore the entry rather than delete the
  line — so the cheap move and the correct move are the same move.
- **Removal has a route that is not deletion.** A rule genuinely leaving the
  inventory moves to *Removed from the inventory* below, with its reason. A
  check whose only escape hatch is deleting the check is a check that gets
  deleted.
- **And the baseline leg has nothing to edit at all.** The sweep separately
  asserts that no id present in the script at `origin/main` has vanished from
  the working tree. History is not a file you resolve, so that leg survives the
  case this one does not: a conflict that hits *both* files and is resolved the
  same careless way in each.

## What a green run of the sweep does and does not mean

**Does:** no inventoried rule is missing entirely from `prompts/`, no id is
duplicated, and no entry present at `origin/main` has silently disappeared.

**Does not:** that a rule is *correct*, that it sits in the section an agent
reads at the moment it acts, or that no other passage in the same file
contradicts it. Those are review questions — see the sweep's header for the
measurement behind that sentence, and `prompts/epic.md` for the reviewer's half.

**Nor that an entry still asserts anything.** This file pins ids, not content. A
merge resolution that keeps an entry's id while taking one side's *patterns*
passes every check here. **Who covers that: nobody mechanical.** It is the
reviewer reading the diff of the `RULES` array, and it is named here so no one
infers a coverage that does not exist.

## The inventory

`H-6` is absent and always was: KAN-186 shipped six rules under seven ids
(`5aea9de`). A check that asserted a contiguous range would be wrong on the day
it was written, which is why this is a list of literal ids and not a count.

<!-- INVENTORY:BEGIN -->
- `H-1` — KAN-186 — a restart can eat in-flight nudges; re-check expected handbacks afterwards
- `H-2` — KAN-186 — the self-paced supervision loop, distinguished from the daemon poller
- `H-3` — KAN-186 — secrets never enter a transcript
- `H-4` — KAN-186 — re-check the justification at the moment of starting, not at approval
- `H-5` — KAN-186, generalised by KAN-334 — a write that reports success is not a write that stored what you sent; read it back and compare
- `H-7` — KAN-186 — a handoff describing future work is a plan, not evidence that it happened
- `H-8` — KAN-237 — merge governance (2026-08-08): the story agent approves, the task agent merges
- `H-9` — KAN-237 — an older ticket's standing rules are stale; the prompt wins
- `H-10` — KAN-239 — the approver: the story by issue link, else the parent epic, never off `activatedBy`
- `H-11` — KAN-239 — the terminating case: when nothing names an approver, say so and do not merge
- `H-12` — KAN-249 — the channel brief: an expected carrier, what its frame is worth, a reply path not urged
- `H-13` — KAN-250 — the storm guards, per carrier: narrowed rather than deleted, no claim of burst safety
- `H-14` — KAN-212 — every Story and Task filed carries a parent epic — the epic, never the story
- `H-15` — KAN-262 — workspace dependencies are linked from the shared store, not installed privately
- `H-16` — KAN-242 — the brief is a snapshot: the commit it came from, and it does not outrank `origin/main`
- `H-17` — KAN-252 — the channel liveness probe is named in the brief, with its ask and declining held open
- `H-18` — KAN-306 — the approval marker: head-pinned, signed, required — and blind to forgery by construction
- `H-19` — KAN-284, cadence unpinned by KAN-351 — the guardian poke is expected, is additional, is on an operator-set interval the brief does not name, and proves only that it was delivered
- `H-20` — KAN-314 — prefer the type to the assertion where the choice exists — scoped, not absolute
- `H-21` — KAN-314 — check the instrument answered the question you asked — filter the CI run by workflow and head
- `H-22` — KAN-314 — a proof run after a failed build, or over a stale `dist`, is a verdict about the old build
- `H-23` — KAN-399 — the status field cannot separate idle from mid-turn; the pane can, so tail every agent
- `H-24` — KAN-399 — tail-first is a safety rule: a composer send can answer a dialog and kill an agent, and idle composer text is the client, not the human
- `H-25` — KAN-399 — the triage is not idle-versus-working: does this agent have an unowned next action it does not know about
- `H-26` — KAN-399 — when you do poke, name the actual work; a generic "continue" produces a generic answer
- `H-27` — KAN-399 — the check-in is always right, the work order usually is not; a sweep that finds nothing to poke is the sweep working
- `H-28` — KAN-388 — an empty result is a claim about your search, a green is a claim about your check: say what the instrument would have printed and confirm it could have reached you
- `H-29` — KAN-466, corrected by KAN-467 — `gh pr merge`'s exit code is not the verdict and `--delete-branch` is what triggers the local failure: `.merged` off REST is the only authority, a surviving branch is the ordinary outcome of a plain merge, on the `-d` path the exit code and the surviving branch are one cause read twice rather than two votes, and the branch delete is performed and proved explicitly
- `H-30` — KAN-471 — a long ticket's comment history is a window: `getJiraIssue` returns 100 of KAN-39's 211 comments and the JQL route 20; parse the saved JSON rather than grepping it, because each completeness field occurs once near the end of the payload and a partial read returns zero of them; and where the envelope strips the container an absent `total` means the read is not self-describing rather than that the ticket is short — the response shape belongs to the client at the moment of the call and can change under you mid-session, so check it per read, cite a comment count with its timestamp, and note that no route on the official MCP pages back to the rest
- `H-31` — KAN-521 — who staffs a ticket is the agent that **filed** it, never its Jira `parent`: the two diverge on every task a story files, because Jira parents a Task to an Epic and nothing else, so the natural reading of the old wording named the epic — the one agent that must not staff it; the worked example must be a case where the parent and the filer differ, and the anti-race property (exactly one agent per ticket) is unchanged
- `H-32` — KAN-597 — the assignee guard added by KAN-577 sits on the Butchr proxy's `atlassian_create_issue` and on no other door: the official Atlassian MCP server's `createJiraIssue` reaches the same site with an optional, undefaulted, unwarned `assignee_account_id`, and the web UI reaches it too, so a ticket filed by either is born unassigned and can never be staffed — file through the proxy, which KAN-603 has since made the only create tool a workspace carries while the proxy is on, and note that this NARROWS the doors rather than closing them (the gate is the proxy mode, an `off` install still gets the official server as its only route, and nothing gates the web UI) — so read `boardControl.health.unstaffable` rather than trusting the rule, because `task/KAN-552` had read this rule at activation and filed two unassigned tickets hours apart anyway
- `R-1` — KAN-237 — retired: the 2026-08-03 rule that the epic agent reviews and merges
- `R-2` — KAN-239 — retired: the fallback naming a task's supervisor of record as its approver
- `R-3` — KAN-334 — retired: the workaround telling agents to avoid nesting a blockquote in a list item
<!-- INVENTORY:END -->

## Removed from the inventory

Ids that were once in the sweep and have been **deliberately** taken out, with
the reason and the ticket. An id listed here is exempted from the baseline leg —
which is the only way to retire an entry without the sweep calling it a drop.

Empty is the correct state. Adding to it is a decision, not a fix for a red.

<!-- REMOVED:BEGIN -->
<!-- REMOVED:END -->
