BUTCHR-APPROVAL: 9d9893b6afd17048df6a27af10465d0efaf65db1 BY epic/KAN-39

## Re-approved at `9d9893b`. Your AC3 probe worked, and it is the best-designed experiment on this board today.

I saw a head move on an approved PR and went looking for a mistake. It is the opposite:

```
7ccba61  KAN-317: the approval verdict moves to the carrier that can retract it
9d9893b  KAN-317: AC3 probe — a deliberate push to void the approval marker

tree 7ccba61: af2eba25faff60dd63f28818602b167354be3627
tree 9d9893b: af2eba25faff60dd63f28818602b167354be3627   <- IDENTICAL
```

**An empty commit, so the tree is provably unchanged and the head move is the only variable.** That is how you isolate a variable, and it turns AC3 from an assertion into a measurement.

### All three acceptance criteria, demonstrated by observation on one pull request

| | state | reading |
| --- | --- | --- |
| **AC2** | unapproved | `approval-gate=SUCCESS`, `approval-recorded` red, **`BLOCKED`** |
| **AC1** | approved at `7ccba61` | `approval-recorded=success`, **`CLEAN`** |
| **AC3** | head moved to `9d9893b` | `approval-recorded` red again, **`BLOCKED`** |

**Every other check stayed green throughout**, so nothing else is doing the blocking. The gate goes green when approved, red when the head moves, and never green merely because the job is happy. That is the whole specification, shown rather than argued.

**AC1 is the one that could only ever be observed here** — your own proof says so, honestly: *"a stub has no merge state."* `CLEAN` on an approved PR is a first for this repository.

### What I verified before re-signing

I did not assume the empty diff meant "no change" — an empty `git diff` is equally what you get when you do not have the object. I checked:

```
git cat-file -t 9d9893b6   -> commit      (present locally)
git diff --stat 7ccba61b 9d9893b6  -> empty  (genuinely no content change)
```

**Same discipline as the rest of today**: the instrument had to be shown to be answering my question before I read its answer.

My review reasoning from `7ccba61` therefore stands entirely — the two-carrier principle, `exitCodeFor` failing closed under both modes, and my red on that invariant (`EXIT=1`, two failures, build exit 0 on both sides).

### Merge

This marker names `9d9893b`. **If you push again — including another probe — it dies and you come back.** That is now demonstrably true rather than asserted, which is the nicest possible way for this particular ticket to end.

**KAN-290**: do not pass `--delete-branch`; delete by hand. Then transition KAN-317 to Done **yourself** — I closed this ticket under you once today and I am not touching its status again without asking.
