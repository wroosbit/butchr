# Prompt staleness: when the rules an agent is following are not the rules

`docs/staleness.md` is about code — the clone that was not pulled, the `dist/`
that was not rebuilt, the daemon still executing what it loaded this morning.
This is the same shape in a different medium, and it is worse in one specific
way: **there is no artifact to rebuild.** The stale thing is a sentence in an
agent's context, and nothing on this machine can reach it.

---

## The defect

A workspace brief is rendered **once, at activation**:

| where | what happens |
| --- | --- |
| `daemon/src/router.ts` (`handleActivateByKey`, `handleActivate`) | `promptLoader.loadAndRender(...)` — **inside `if (!session)`**, so only for a session that does not yet exist |
| `daemon/src/prompt.ts` | reads `prompts/<type>.md` off the daemon's own `repoRoot` and substitutes `{{KEY}}`, `{{URL}}`, `{{PROMPT_PROVENANCE}}` |
| `daemon/src/herdr.ts` (`initPty`) | writes the result to `<workspace>/.butchr-prompt.md`, refusing the activation if it cannot |
| `daemon/src/launchers.ts` | `claude … --continue \|\| claude … 'Please read and follow the instructions in .butchr-prompt.md to begin.'` |

Nothing refreshes that file while the agent lives — and the half that matters
more, **nothing makes the agent re-read it if something does.** The `--continue`
arm restores a conversation that already contains the bytes read the first time.

### It has cost two hours, measured

`task/KAN-234` sat In Review from 09:50 to 12:18 on 2026-08-08 believing
`epic/KAN-39` was its approver and that it must not merge. Merge governance had
changed at 10:57 (`efde3cb`). Its brief, rendered at 09:34:59, was **correct when
it was written** — which is exactly why nobody re-checked it. A brief does not
read like a dated decision; it reads like a standing rule.

### Rewriting the file does not fix it, and this is not an argument

`epic/KAN-203` has held **one conversation since 2026-08-06T20:29Z**. Reads of
`.butchr-prompt.md` in that conversation, from its own transcript:

```
2026-08-06T20:29:32Z   line   11
2026-08-08T19:27:58Z   line 3209
2026-08-10T02:27:12Z   line 3865
```

Three reads in four days. Meanwhile the file was re-rendered and rewritten by
every ordinary daemon restart — most recently at 05:17 on 2026-08-10, which the
agent has not read. So:

> **The copy on disk is fresh and the agent's context is stale, at the same
> time.** `stat` on the workspace reports the restart, not the agent.

That is why *"rewrite the file in place when `prompts/*.md` changes"* was
rejected as the fix. It is **already what happens**, it already does not work,
and it destroys the one forensic signal — the mtime — that the original
diagnosis was built on.

### And the mitigation pointed at the stale thing

`prompts/task.md` told agents: *"Your ticket may still tell you the old rule, and
this file wins."* That is right about a stale **ticket** and wrong about a stale
**prompt**, and this file is the copy nobody refreshes. The rule we had for
stale tickets was directing agents to trust the artifact most likely to be out
of date.

---

## The decision (KAN-242)

Four options were on the table. Two were rejected on evidence, not on taste.

| option | verdict |
| --- | --- |
| **Rewrite the brief in place for live agents** | **Rejected.** Already happens on every activation; measured not to work (above); erases the mtime evidence. |
| **Notify live agents that their prompt is stale** | **Rejected as the primary fix.** It fans a message at the whole fleet on every prompt commit, the storm guards reserve sends for meaningful transitions, and a notice still has to say *what* changed — which needs the stamp anyway. Worth revisiting only if the check below turns out to be run too rarely. |
| **Fix the sentence** | **Adopted, and it is the load-bearing half.** There is no mechanism to add: the failure was an instruction that was wrong. |
| **Stamp the brief with its source commit** | **Adopted in a reduced form**, because the sentence alone is not actionable. |

**Why both, when the ticket allowed "the sentence is the whole answer".** An
instruction to *"re-read the rule at `origin/main` before acting on it"* asks an
agent to diff two copies of a 40 KB document by eye and decide whether a
governance clause moved. It cannot, so it will not. The stamp reduces that to a
`git log` whose empty output is the entire answer. The stamp is not the fix; it
is what makes the fix cheap enough to be obeyed.

**What was deliberately not built:** any mechanism that reaches into a running
agent, and any change to merge governance itself (that is KAN-239, `2bd98ad`).

---

## What ships

**`{{PROMPT_PROVENANCE}}`**, substituted by `PromptLoader` at render time —
computed *in the loader*, not passed in by callers, so neither render call site
can forget it:

```
- **Rendered** 2026-08-10 05:22, from `/home/brooswit/code/wroosbit/butchr`.
- **`prompts/task.md` last changed in `21a6e14`** — *KAN-250: re-derive the storm guards…* (2026-08-09 21:29).
- **To find out whether that is still the rule**, run these two — they are the whole check:

  ```bash
  git -C /home/brooswit/code/wroosbit/butchr fetch origin
  git -C /home/brooswit/code/wroosbit/butchr log --oneline 21a6e14..origin/main -- prompts/task.md
  ```

  **No output means this brief is current**… **Any line is a rule that changed after you were briefed**…
```

Three properties it has to have, each of which a plausible implementation gets
wrong:

1. **The template's own last commit, never `HEAD`.** `HEAD` moves on every
   unrelated commit, so the comparison would list changes to files the reader
   does not care about — noise, which trains an agent to stop running it.
2. **An absolute path.** CrabCast's agents are briefed from these same four
   files, out of Butchr's checkout, and have no `prompts/` of their own.
   (Checked rather than assumed: `router.ts` resolves every workspace type's
   template against the daemon's `repoRoot`, whatever repository the agent then
   works in.)
3. **Honest silence.** Where git cannot answer — not a checkout, never
   committed — the block says so and tells the reader to go to `origin/main`
   anyway. It never omits itself, because an absent block reads as "nothing to
   check here".

**`## This brief is a snapshot, and it can be out of date`** in all four
`prompts/*.md`, placed before the first instruction section so it is met before
any governance rule. It carries the block, names the moment to run the check
(*at the point a governance rule decides what you do* — not on a schedule), and
scopes the old sentence: this file beats a stale **ticket**, and does not beat
`origin/main`.

**`daemon/src/resume.ts`** stops calling the file *"your original instructions"*,
and the restored-conversation nudge now says the plain thing the daemon alone
knows: *your brief was rewritten by this restart and you have not re-read it.*

---

## What is proved, and by what

| claim | proved by | kind |
| --- | --- | --- |
| every prompt carries the section, and the placeholder inside it | `verify-operative-rules-are-carried.mjs` rule **H-14** | required CI |
| the stamp names the template's commit and not `HEAD`; its embedded commands run, answer "current" when current, and name the superseding commit when the rule moves; it degrades honestly off-git | `verify-prompt-provenance-stamp.mjs` | deterministic, 21 cases |
| **an agent reads it, runs the check, and follows the new rule** | `probe-stale-rule-compliance.mjs` | live experiment, not CI |

The third row is the one that matters and the one no script can assert. It runs
two real agents on two isolated daemons, moves a governance rule under both
*after* they are briefed, sends both the same request, and reads which rule each
obeyed off the filesystem.

### What none of them cover

- **Whether an agent recognises an unlabelled clause as governance.** The probe
  labels its rule as governance in so many words; a real brief does not. This is
  the likelier production failure and nothing measures it.
- **Whether an agent that checks once keeps checking.** KAN-234's stall ran two
  and a half hours across many turns. The probe measures one moment.
- **Whether the section survives into a production `.butchr-prompt.md`** rendered
  from the whole 40 KB file for a real ticket. The probe splices one section onto
  a neutral preamble. A `grep` of a live workspace, pasted into the PR by hand,
  is what covers this.

---

## Related, and deliberately not merged with this

`butchr_staleness_check` (`daemon/src/staleness.ts`, `docs/staleness.md`) answers
*is the running code the merged code*. Same shape, different medium, and there is
a real interaction worth stating: **the daemon's own checkout can be behind
`origin/main`**, so a brief rendered one second ago can still carry a superseded
rule. That is why the check in the block compares against `origin/main` and not
against the local `main` the brief was rendered from.
