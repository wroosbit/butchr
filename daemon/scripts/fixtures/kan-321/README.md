# KAN-321 — the two real comments that define the defect

These are **recordings of real artifacts**, not fixtures anybody invented. They
are the two comments on [#139](https://github.com/wroosbit/butchr/pull/139) that
sat 62 seconds apart and that the `approval-recorded` gate could not tell apart:

| file | comment | what it is |
| --- | --- | --- |
| `pr139-comment-5260338837-request.md` | [5260338837](https://github.com/wroosbit/butchr/pull/139#issuecomment-5260338837) | `task/KAN-317` **asking** `epic/KAN-39` for an approval, quoting the line it needed inside a code fence. Turned the required check green at 00:09:05Z. **Nobody had approved.** |
| `pr139-comment-5260345802-approval.md` | [5260345802](https://github.com/wroosbit/butchr/pull/139#issuecomment-5260345802) | `epic/KAN-39`'s **genuine** approval, 62 seconds later at 00:09:52Z. Marker on line 1, at top level. |

`verify-approval-recorded.mjs` §11 drives both through `evaluate` and asserts the
first is refused and the second accepted. Using the real bodies is the point:
a hand-written fixture would only prove the scanner does what its author
believed a fenced marker looks like.

## They are checked in because the proof must run with no egress

`verify-approval-recorded.mjs` is in the CI-runnable set, which means no network.
A recording is the only way to have both properties, and it is a recording — it
was true of GitHub at the moment it was taken and nothing here re-checks that.

**Both are by the GitHub user `brooswit`**, which is the whole reason the gate
cannot use authorship to tell a request from an approval: every agent in this
fleet authenticates as the same account. That is the documented forgery limit,
and it is why the fix reads the comment's *structure* instead.

## Re-fetching them, byte for byte

`--jq .body` appends a newline, so it does **not** reproduce these files. This
does:

```sh
gh api repos/wroosbit/butchr/issues/comments/5260338837 \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).body))' \
  | sha256sum
```

| file | bytes | sha256 |
| --- | --- | --- |
| `pr139-comment-5260338837-request.md` | 6339 | `33b6df9e770868b5dcf4fb62f0ab7f70feeb2f9b0ac2d6b859ecf2715eb56b61` |
| `pr139-comment-5260345802-approval.md` | 2703 | `7efaf8fb786d7a403ac5c8c870deb6856b43d37f0297cb1327eceedef9b964b0` |

A GitHub comment is editable, so a future mismatch means the comment was edited
after 2026-08-12 — not that this recording was wrong. Compare against the hashes
above rather than assuming either side.
