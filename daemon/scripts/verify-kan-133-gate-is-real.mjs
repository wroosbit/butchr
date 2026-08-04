// KAN-133: a deliberately broken `verify-` script, pushed to watch the new
// required `verify-script-sweep` check go red, then removed in the next commit.
//
// It breaks both arms of the sweep's rule at once:
//   1. This header names a commit, not a defect — it never states which failure
//      the script would catch, which is precisely the omission the sweep exists
//      to flag.
//   2. Its only exit is an unconditional zero. It prints FAILED and exits 0 —
//      the exact shape of the bug KAN-119 found five times over.
//
// A green check nobody has watched go red is not a gate. This commit is the red.

console.log('FAILED — and exiting 0 anyway, which is the whole problem.');
process.exit(0);
