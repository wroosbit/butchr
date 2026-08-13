# What the PR watcher watches, and why the set is the shape it is

**KAN-360.** `daemon/src/pr-watch.ts` reads pull requests once a minute and tells
whoever they concern. This page is about the prior question — **which
repositories it reads at all** — because that set had a hole in it that nothing
in the report could disclose, and because the escape hatch for the hole it still
has is an environment variable that has to be written down somewhere or it does
not exist.

## The defect this replaced

The watch set was discovered from live agents' checkouts, which is right and is
still the primary path. It has one property nobody had stated:

```
epic/kan-39   NO git checkout
epic/kan-203  NO git checkout
epic/kan-59   NO git checkout
```

**No supervisor holds a checkout.** Only task agents do, in their worktrees. So
the set was built entirely by the agents a PR notification is *not* for, and
emptied when they stood down:

1. a task agent opens a pull request and finishes;
2. it stands down, and its worktree was the only thing holding that repository
   in the set;
3. the repository leaves the set;
4. **the approver — still running, still responsible, holding no checkout —
   stops being told anything about that pull request;**
5. the report says *"Watching 1 repository"* and nothing about having watched two
   an hour ago.

Observed by `epic/KAN-203` as three `prWatch` readings 35 minutes apart on
2026-08-12: `repos: crabcast + butchr` → `repos: butchr ONLY`, as CrabCast's last
live checkout went away. Nothing was broken and nothing went red. The shape is
the wrong way round for an unattended fleet: the quiet hours are when a pull
request sits longest, when nobody is looking by hand, and when the watcher
covered least.

## The three ways in

A repository is in the set for exactly one of three reasons, and the health
report names which — that is `RepoSource` in `github.ts`, and it is a type rather
than a comment so that a fourth way in cannot be added without declaring it.

| source | meaning | when it stops being true |
| --- | --- | --- |
| `config` | named in `BUTCHR_PR_WATCH_REPOS` | when somebody changes the variable |
| `checkout` | a live agent holds a checkout of it | **the moment that agent stands down** |
| `memory` | the watcher's durable memory says a pull request there is still OPEN | when that pull request merges or closes |

`memory` is the retention rule and the whole of the fix. It is derived from
**responsibility** rather than from possession, it survives a daemon restart
because `~/.local/share/butchr/pr-watch.json` does, and it releases by itself —
the tick that records a merge is the last tick that repository is retained for.

The report reads, e.g.:

```
Watching 1 of the 2 seen repositories: wroosbit/butchr (a live agent holds a
checkout). Not watched now, and seen before: wroosbit/CrabCast — nothing there is
outstanding (no live checkout, and no open pull request in memory). Anything
opened there while nobody holds a checkout would be unobserved until somebody
does.
```

## What retention does not cover

Stated because the table above looks total:

* **A pull request no tick ever saw open.** Retention is self-sustaining, not
  self-starting: the repository must be watched once, with the pull request
  open, for there to be anything to retain. An agent that opens a PR and stands
  down inside one 60-second tick, or one that opens a PR while the daemon is
  down and is gone before it comes back, leaves nothing behind.
* **A repository nobody has ever worked in.** By construction.

## `BUTCHR_PR_WATCH_REPOS` — the override, and where to write it

Both holes above are what it is for, and this section is the durable record
KAN-339's AC2 asks for: **a step performed once and undocumented is the ticket
again after the next machine rebuild.**

Comma-separated `owner/name`, read by `discoverRepos` on every tick, so it takes
effect on a daemon restart and needs no code change:

```ini
# ~/.config/systemd/user/butchr-daemon.service.d/override.conf
[Service]
Environment=BUTCHR_PR_WATCH_REPOS=wroosbit/butchr,wroosbit/CrabCast
```

```bash
systemctl --user daemon-reload && systemctl --user restart butchr-daemon
```

Confirm it took by reading `prWatch.repos` out of `butchr_list_agents`: each
entry will carry `source: "config"`. **A variable exported in one shell is not
this** — it is gone at the next restart, and the watcher will be back to
discovery with nobody having been told.

**It replaces discovery; it does not switch retention off.** A repository named
here is watched whatever the fleet is doing, *and* anything the memory says is
outstanding is still watched as well. "Watch exactly these and nothing else"
would reintroduce the blindness for every pull request opened after the list was
written, which is the defect this page is about.

## Why not the two other candidates

Both were live options in KAN-360 and both are recorded here rather than in a
commit message, because the next person to look at this will have the same three
ideas.

**A sticky set for the daemon's life.** Cheap, and it makes the set monotonic
within a process — but a daemon restart still empties it, and a set that only
ever grows pays GitHub three rate-limit points a minute in perpetuity for every
repository anybody has ever touched while reporting full coverage. Retention off
the durable memory has neither problem: it survives the restart *and* it
releases. `daemon/scripts/verify-pr-watch-repo-retention.mjs` §5 and §6 are the
two halves of that, and `red-drive-kan360.sh` mutation 5 is this candidate,
implemented and watched to go red.

**Derive the set from what each supervisor is responsible for.** The more
faithful idea, and not buildable — for a stated reason rather than a cost:
**nothing maps a ticket to a repository.** Jira carries no such field, and
KAN-360's own description names `wroosbit/butchr` in prose. The only route from a
supervisor to a repository runs through the agents under it, which is the
checkout path again and drains at exactly the same moment. What survives of the
idea is its principle, and the retention rule is that principle applied to the
one durable responsibility signal the daemon actually holds: an open pull request
whose branch names a ticket of this fleet's.
