// KAN-306: a DELIBERATELY RED member of the CI-runnable set.
//
// THIS FILE IS A THROWAWAY AND MUST NEVER MERGE. It exists on the branch
// `butchr/KAN-306-gate-demo` only, to answer acceptance criterion 1 of KAN-306:
// that with `verify-runnable-set` red a pull request reports `BLOCKED` rather
// than `UNSTABLE`. `UNSTABLE` is what a non-required check produces, and it is
// the tell that four agents read past on #129 while believing the required set
// had grown to six. It had grown as a job, not as a gate.
//
// WHAT FAILURE THIS WOULD CATCH: `verify-runnable-set` reporting a red without
// blocking the merge — i.e. the job running, going red, and a pull request
// merging anyway. That is precisely the state this repository was in between
// #126 landing the job and KAN-306 adding it to the required contexts.
//
// CI-RUNNABLE: yes — imports nothing at all and asserts on a constant; it needs
// no herdr, no live daemon, no credential, no peer and no terminal. It is in
// the set on purpose, because being in the set is the whole demonstration.

const failures = 1;

console.log('KAN-306 gate demonstration: failing on purpose so that `verify-runnable-set`');
console.log('goes red, so that the pull request can be observed reporting BLOCKED.');
console.log('');
console.log('If you are reading this on `main`, something has gone very wrong: this file');
console.log('was never meant to merge. Delete it and say so on KAN-306.');

process.exit(failures ? 1 : 0);
