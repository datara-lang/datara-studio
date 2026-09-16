#!/usr/bin/env python3
"""Count task completion in TASKS.md.

The progress table in TASKS.md claims a number. This script produces it, so the
claim can be checked instead of trusted.

Usage:  python scripts/task_status.py [TASKS.md]
"""

import re
import sys
import pathlib


def main():
    path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "TASKS.md")
    if not path.exists():
        print("no such file: %s" % path, file=sys.stderr)
        return 1

    section = None
    counts = {}
    order = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.startswith("## "):
            section = line[3:].strip()
            if section not in counts:
                counts[section] = [0, 0]
                order.append(section)
        if section and re.match(r'^- \[( |x|~)\]', line):
            counts[section][1] += 1
            if line.startswith("- [x]"):
                counts[section][0] += 1

    done_total = 0
    all_total = 0
    for s in order:
        done, total = counts[s]
        if total == 0:
            continue
        pct = 100.0 * done / total
        print("%-36s %3d / %3d  %5.1f%%" % (s[:36], done, total, pct))
        done_total += done
        all_total += total
    print("-" * 58)
    pct = 100.0 * done_total / all_total if all_total else 0.0
    print("%-36s %3d / %3d  %5.1f%%" % ("TOTAL", done_total, all_total, pct))
    return 0


if __name__ == "__main__":
    sys.exit(main())
