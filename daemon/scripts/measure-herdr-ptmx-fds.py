#!/usr/bin/env python3
"""Account for the herdr server's /dev/ptmx descriptors, per KAN-24.

The herdr server holds ~5 `/dev/ptmx` fds per pane, which was reported as a
leak. It is not one. This distinguishes the two possibilities that a raw count
cannot:

  * 5 separate open("/dev/ptmx") calls would mean 5 *ptys* per pane, and 5
    wasted slave devices.
  * 5 descriptors sharing one open file description means one pty, dup()ed —
    wasteful of descriptors only.

kcmp(2) with KCMP_FILE answers it: it reports whether two descriptors refer to
the same open file description. The measured answer on herdr 0.6.4 is the
second — 1 master per pane, dup'ed 5 ways, all released when the pane closes.

Usage: daemon/scripts/measure-herdr-ptmx-fds.py [pid]

With no pid it finds the running `herdr server`. Requires Linux (/proc and
kcmp) and the same uid as the target process.
"""
import ctypes
import os
import sys

SYS_kcmp = 312   # x86_64
KCMP_FILE = 0

libc = ctypes.CDLL("libc.so.6", use_errno=True)


def kcmp_same_file(pid, fd1, fd2):
    r = libc.syscall(SYS_kcmp, pid, pid, KCMP_FILE, fd1, fd2)
    if r < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err))
    return r == 0


def find_herdr_server():
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as fh:
                argv = fh.read().split(b"\0")
        except OSError:
            continue
        if len(argv) >= 2 and argv[0].endswith(b"herdr") and argv[1] == b"server":
            return int(entry)
    return None


def soft_fd_limit(pid):
    with open(f"/proc/{pid}/limits") as fh:
        for line in fh:
            if line.startswith("Max open files"):
                return int(line.split()[3])
    return None


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else find_herdr_server()
    if pid is None:
        sys.exit("no `herdr server` process found; pass a pid explicitly")

    fd_dir = f"/proc/{pid}/fd"
    ptmx, pts = [], 0
    for name in os.listdir(fd_dir):
        try:
            target = os.readlink(f"{fd_dir}/{name}")
        except OSError:
            continue
        if target == "/dev/ptmx":
            ptmx.append(int(name))
        elif target.startswith("/dev/pts/"):
            pts += 1
    total = len(os.listdir(fd_dir))
    limit = soft_fd_limit(pid)

    # Group the ptmx fds by open file description. O(n^2) in the number of
    # distinct masters, which is the number of panes — small enough.
    groups = []
    for fd in sorted(ptmx):
        for group in groups:
            if kcmp_same_file(pid, group[0], fd):
                group.append(fd)
                break
        else:
            groups.append([fd])

    print(f"herdr server pid {pid}")
    print(f"  open fds ............ {total} / {limit} soft limit "
          f"({100 * total // limit if limit else '?'}%)")
    print(f"  /dev/ptmx fds ....... {len(ptmx)}")
    print(f"  /dev/pts/* fds ...... {pts}")
    print(f"  distinct pty masters  {len(groups)}   <- actual ptys")
    if groups:
        sizes = {}
        for group in groups:
            sizes[len(group)] = sizes.get(len(group), 0) + 1
        print("  fds per master:")
        for size in sorted(sizes):
            print(f"    {size} fd(s) -> {sizes[size]} master(s)")
        surplus = len(ptmx) - len(groups)
        print(f"  descriptors beyond one per master: {surplus}")
        print()
        print("  Interpretation: descriptors sharing one description are dup()s of a")
        print("  single pty master, not extra ptys. They cost descriptors only, and")
        print("  a pane returns all of them when it closes.")


if __name__ == "__main__":
    main()
