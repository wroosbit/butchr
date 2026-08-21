"""KAN-587's two router.ts mutations, factored out of red-drive-kan587.sh.

It lives here rather than inline in the shell script for one reason: both
mutations are anchored on an exact multi-line block of TypeScript, and a
here-document nested inside another here-document is how such an anchor
silently loses a character. A file has no quoting layers.

    delete  remove the refuseWriteOutsideCaller(...) block from the handler
    pad     insert 700+ characters of comment immediately above it

Both are anchored on text that must occur EXACTLY ONCE. Anything else exits
non-zero and writes nothing, so the caller reports "router.ts has moved on"
rather than mutating a file it did not recognise. This is a red-drive helper: it
is never imported by a verify script and proves no product behaviour.
"""

import io
import sys

CALL_BLOCK = (
    "    const writeRefusal = refuseWriteOutsideCaller(operation, args, callerIdentity);\n"
    "    if (writeRefusal) {\n"
    "      fail(writeRefusal.error, { reason: writeRefusal.reason, mode: decision.mode });\n"
    "      return;\n"
    "    }\n"
)

CALL_LINE = (
    "    const writeRefusal = refuseWriteOutsideCaller(operation, args, callerIdentity);"
)

PAD_LINE = "    // padding to push the policy call away from the method name; 700 chars.\n"


def main(argv):
    if len(argv) != 3 or argv[1] not in ("delete", "pad"):
        sys.stderr.write("usage: kan587-mutate-router.py {delete|pad} <router.ts>\n")
        return 2

    mode, path = argv[1], argv[2]
    src = io.open(path, encoding="utf-8").read()
    anchor = CALL_BLOCK if mode == "delete" else CALL_LINE

    found = src.count(anchor)
    if found != 1:
        sys.stderr.write(
            "  anchor for '%s' occurs %d times in %s, expected exactly 1 — "
            "writing nothing.\n" % (mode, found, path)
        )
        return 1

    if mode == "delete":
        io.open(path, "w", encoding="utf-8").write(src.replace(anchor, ""))
        print("  deleted the refuseWriteOutsideCaller(...) block from handleAtlassianProxyCall")
        return 0

    pad = ""
    while len(pad) < 700:
        pad += PAD_LINE
    io.open(path, "w", encoding="utf-8").write(src.replace(anchor, pad + anchor))
    print("  inserted %d characters of comment above the policy call" % len(pad))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
