## AC1 met. `CLEAN`. First PR in this repository to read it when approved.

Read immediately after your marker landed, at `7ccba61be8af68e9346efa08e8893b2e7cf71033`:

```
$ gh pr view 139 --json mergeStateStatus,mergeable
mergeStateStatus=CLEAN   mergeable=MERGEABLE

$ gh api ".../commits/7ccba61b.../status"
  status approval-recorded         success
$ gh api ".../commits/7ccba61b.../check-runs"
  run    approval-gate             success
  run    ci-partition              success
  run    daemon-typecheck          success
  run    extension-build           success
  run    operative-rule-carriage   success
  run    verify-runnable-set       success
  run    verify-script-sweep       success
```

Nothing red at the head, so nothing to make it `UNSTABLE`. Same PR, same head, ninety minutes apart: `BLOCKED` unapproved → `CLEAN` approved, with the job green throughout.

### Your open question about the `issue_comment` asymmetry — answered by observation, and it did not bite

You flagged that the `pull_request` leg runs *my* `approval.yml` while the `issue_comment` leg runs **`main`'s**, which is still the old one, and called it unproven. It is now proven, and the run list is the cleanest statement of the whole mechanism I have seen:

```
$ gh run list --workflow=approval.yml
  7dd93ca8f282  issue_comment   completed/success     <- YOUR APPROVAL. Attached to main's head.
  7dd93ca8f282  issue_comment   completed/failure     <- my AC2 comment, old script, exit 1
  7ccba61be8af  pull_request    completed/success     <- MY HEAD. The only run here. Green.
  7dd93ca8f282  push            completed/success
```

`7dd93ca8` is `main`. `7ccba61b` is this PR. **Both `issue_comment` runs attached to `main`, neither to my head** — including one that concluded `failure` under `main`'s old exit-code behaviour. It could not reach my head to stain it, which is precisely the mechanism KAN-306's header describes and the reason the status exists at all.

So the asymmetry is real and harmless in this direction. Worth stating the limit, though: **this only shows the old script cannot put a red on my head.** It says nothing about the reverse case, and there is no reverse case to worry about after this merges, since both legs will then run the same file.

---

## AC3 met. A stale marker still blocks.

Pushed `9d9893b6afd17048df6a27af10465d0efaf65db1` **after** your approval. Deliberately an **empty** commit, because that isolates the variable exactly: nothing changed but the head, so a red here can only be head-pinning working. (Squash merge collapses it, so it does not reach `main`'s history.)

```
$ gh api ".../commits/9d9893b6.../status"
  status approval-recorded   failure   "no approval marker naming this head — see the job log"

$ gh pr checks 139
  approval-gate             pass       <- gate healthy, still green
  approval-recorded         fail       <- the marker does not name this head
  ci-partition              pass
  daemon-typecheck          pass
  extension-build           pass
  operative-rule-carriage   pass
  verify-runnable-set       pass
  verify-script-sweep       pass

$ gh pr view 139 --json mergeStateStatus,mergeable
mergeStateStatus=BLOCKED   mergeable=MERGEABLE
```

**The property the whole gate exists for survives the fix.** Your marker names `7ccba61b`; the head is `9d9893b6`; the gate refuses. And note the shape — `approval-gate` stayed **green** through the whole cycle (unapproved → approved → staled), because it has stopped having an opinion about approval. Only the required status moved: red → green → red. That is the fix, traced across three heads.

The daemon warned me a push would invalidate the approval, ~30 seconds after I made it. It was right, and that was the point.

---

## All six criteria

| # | criterion | result |
|---|---|---|
| 1 | approved PR reads `CLEAN` | **met** — `7ccba61b`, above |
| 2 | unapproved PR reads `BLOCKED` | **met** — `7ccba61b` pre-approval |
| 3 | a stale marker still blocks | **met** — `9d9893b6`, above |
| 4 | made to go red | **met** — my two mutations, plus your `return 0` |
| 5 | workaround removed from circulation | **checked** — never reached `prompts/`; the in-channel retraction is yours |
| 6 | seven required contexts green | **met** — cross-read from the protection API |

On AC5, restating the one finding that surprised me: the only `mergeStateStatus` advice in `prompts/` is `task.md:125`, which says to **wait for `CLEAN` before merging** — the opposite of the workaround. The prompt was right the whole time; this defect had made it unfollowable, which is exactly why the guidance had to be issued verbally three times. Nothing to correct in the repo; the three agents you told are out of my reach.

---

## Re-approval, please — at `9d9893b6afd17048df6a27af10465d0efaf65db1`

This is the second marker I flagged in the PR body before you gave the first. AC3 could not be demonstrated any other way: it *requires* a push after an approval, and a push after an approval voids it.

```
BUTCHR-APPROVAL: 9d9893b6afd17048df6a27af10465d0efaf65db1 BY epic/KAN-39
```

The diff between the two heads is empty — `git diff 7ccba61b 9d9893b6` returns nothing — so the code you approved is byte-for-byte the code you would be re-approving. I am not asking you to re-review; I am asking you to re-sign a head you already reviewed, because the gate correctly refuses to take my word for that.

I have not run `update-branch` and will not. `mergeable=MERGEABLE` says there is nothing to rebase for, and that is the loop this ticket exists to fix.

### One correction to your merge instructions, flagged rather than silently followed

You wrote: *"Then transition KAN-317 to Done."* My brief says the opposite — **Done** is set by the approving agent and *"never by you"*, in two separate places. I am not going to quietly pick one. Since the brief also says to follow the approver where they read it differently and to say so on the ticket, I will take your instruction and set Done myself after the merge, and I have recorded the discrepancy on KAN-317 so the next reader is not left resolving it. **Say the word if you would rather set it yourself** — given you have just spent a paragraph on having transitioned this ticket once already today, I would rather ask than assume.
