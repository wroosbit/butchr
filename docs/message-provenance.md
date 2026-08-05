# Whose voice is this? Provenance on messages typed into an agent

**KAN-149.** Repository read at `8ce62c3`. Written alongside the change, so the
"before" column is what this branch's merge base actually did.

---

## The problem, in one line

Butchr delivers messages by **typing them into the target's composer and pressing
Enter**, so a nudge from another agent is byte-for-byte what the human typing
would look like. There is no channel to read a sender off, because the channel is
a keyboard.

KAN-150 asked whether this could be replaced by protocol delivery. KAN-167
established that it cannot: Claude Code drops server-initiated
`notifications/message`, and the protocol is moving away from that shape rather
than toward it (`docs/mcp-notification-delivery.md`). **Typing is the mechanism
indefinitely**, so it is worth marking.

## What was already true before this change

Established by reading the code at the merge base, not assumed:

| Path | Where | Tag before |
| --- | --- | --- |
| Supervision notice (KAN-77) | `nudge.ts` `supervisionNudgeText` | `[butchr daemon]` |
| Jira-poll pointer (KAN-79) | `jira-poll.ts` `jiraEventNudgeText` | `[butchr daemon]` |
| Resume nudge (KAN-21/37) | `resume.ts` `resumeNudge` | `[butchr]` — **a fourth spelling of a token the prompts never taught** |
| **Agent → agent** (`butchr_send_to_agent`) | `router.ts` `handleSendToAgent` | **none** |

So the epic agent's read was right: the daemon's own notices were largely
marked already, and the gap was the agent-to-agent path — which is precisely the
one that caused the original incident. `handleSendToAgent` destructured
`{ key, type, message }` off a request that *already carried*
`workspaceType`/`workspaceKey` (KAN-145 put them on every MCP request) and threw
them away.

## What changed

`daemon/src/provenance.ts` owns the vocabulary; `handleSendToAgent` stamps the
tag; the three daemon builders import the one constant instead of spelling it
three ways.

* `[from story/KAN-75] …` — another agent, named from **the caller's own MCP
  process identity**, never from the message body.
* `[butchr daemon] …` — the daemon itself.
* `[from an unidentified butchr caller] …` — a caller with no workspace identity.

## Point 4 of the ticket: can the *human's* channel be marked at the source?

The ticket called this the stronger direction, and asked for an answer either
way. **The answer is that it does not need to be marked, because the complement
is now closed** — which gets the same property by the other route.

There are exactly four writers into an agent's pane. Enumerated from the code,
not assumed:

| # | Writer | Marked? |
| --- | --- | --- |
| 1 | `router.ts:handleSendToAgent` — every MCP caller | **yes**, from the caller's identity |
| 2 | `nudge.ts:127` — resume nudge | **yes**, `[butchr daemon]` |
| 3 | `nudge.ts:299` — `deliverToAgent` (supervision + Jira poll) | **yes**, `[butchr daemon]` |
| 4 | A human's keystrokes into the herdr pane | **no — and no Butchr code runs at all** |

Writer 4 is not reachable, and the reason is worth stating: a human typing into a
terminal is the terminal doing its job. There is no Butchr code in that path to
add a marker with — not in the daemon, not in the extension. **The extension has
no message-sending surface whatsoever**; its fleet controls activate, deactivate
and read state, and `grep -rn send_to_agent extension/` is empty. There is
nothing there to mark.

But because writers 1–3 are now *all* marked, **"unmarked means the human" stops
being an assumption and becomes the complement of a closed set.** That is what
point 4 was actually asking for. It is why an unidentified caller is tagged
`[from an unidentified butchr caller]` rather than delivered bare: a single
untagged injection anywhere would reopen the set and make "unmarked"
uninterpretable again.

## The limit, stated plainly

**This is a convention, not authentication.** Written here, in
`provenance.ts`, and in all four prompts, because a marker trusted more than it
deserves is worse than no marker.

* An agent can type `[from epic/KAN-39]` into a message body. The daemon's tag is
  always the **leading** one, so the forgery shows up *behind* the real tag
  rather than replacing it — but the text is there, and a careless reader can
  still read it.
* Any process that can reach the daemon's Unix socket can state any identity on
  the wire. The socket is the trust boundary and it is a filesystem permission,
  not a credential check.
* A human's own Claude Code session calling `butchr_send_to_agent` is marked
  unidentified — correctly, because it is a *relay* and not the human's own
  voice, but it is not distinguished from any other identity-less caller.

It removes **accident**, not malice. Accident is what has been costing us: three
misattributed interrupts in two days, none of them anyone's idea of an attack.

## The second failure mode, which a tag does not fix

Worth recording because it is the sharpest evidence for the ticket and the tag
does **not** close it. KAN-167 observed a `butchr_capacity` call return *"The user
doesn't want to proceed with this tool use. The tool use was rejected."* **Nobody
rejected anything** — a nudge landed mid-call and the runtime rendered the
interrupt as a user rejection.

That misattribution comes from the *runtime's own rendering*, not from a message
body, so no tag on a message can prevent it. The defence is in the prompts: an
interrupt that surfaces as a rejection may be another agent's nudge, so re-issue
the call rather than reporting a refusal the human never made. Had KAN-167
believed the report, it would have recorded "capacity refused" and the finding
that this whole ticket now rests on would never have been established.

## Proof

`daemon/scripts/verify-message-provenance.mjs`. Sections 2–4 spawn a real
`daemon/dist/mcp.js` from the real `.mcp.json` a real activation wrote, so the
identity is never supplied by the script — the tag can only be right if it
survived the whole journey. Section 5 calls the daemon's builders directly and
says so in its own output.

What the script cannot cover, and who does: a live pane rendering the tag is
observation, not assertion, and lives in the KAN-149 PR body as a real
`butchr_tail_agent` transcript.
