#!/usr/bin/env python3
"""Ryan Harness Core :: Datara source linter / fixer.

Datara (forgen 1.3.0) has a number of rules that the README does not state
accurately. Rather than rediscovering them on every compile, this script
enforces the rules that were established empirically against the compiler.

Rules enforced
--------------
FIX (rewrites the file):
  R1  read-only struct parameters must be declared `view name: Type`, otherwise
      the affine ownership checker rejects the second use of the value.
  R2  `str_starts_with` / `str_ends_with` / `str_contains` return Int, not Bool,
      so a bare use in a condition is rewritten to `... == 1`.

CHECK (reports, does not rewrite):
  R3  reserved keywords used as identifiers
  R4  if-expressions (`let x = if ...`) - Datara has no if-expressions
  R5  bitwise `|` or `&` - Datara has only the `math_or` / `math_and` builtins
  R6  `pub` on struct fields - not accepted by the compiler
  R7  top-level `pub let` - not accepted; use a zero-argument fn
  R8  `out` used as an identifier - `out` is a statement keyword
  R9  `-> T!` result shorthand - use Outcome<T> from stdlib.result.result
  R10 two structs declaring the same field name with different SCALAR types
  R11 two structs declaring the same field name at all (see below)

R11 is the rule that actually matters, and it subsumes R10.

forgen 1.3.0 keeps struct field offsets in ONE global table keyed by field name.
The **first struct to declare a name fixes that name's offset**; every later
struct that reuses the name silently reads and writes at the first struct's
offset. There is no diagnostic and no warning. The only symptom is wrong data at
runtime, and it is layout-dependent, so it appears and disappears as unrelated
fields are added.

Measured (probes/fieldnames_shared vs probes/fieldnames_unique):

    three structs sharing field names  -> 2 of 3 corrupt
    same three with unique field names -> all 3 correct
    each layout in its own project     -> all correct

Therefore: **every struct field name must be globally unique.** Type-consistency
is NOT sufficient (R10 was an earlier, weaker theory that turned out to be a
special case). Run `python scripts/uniquify_fields.py src --apply` to fix.

R10 is kept because it names the more specific failure - a scalar type clash -
which is worth seeing in the report even though R11 will also fire.
"""

import argparse
import glob
import os
import re
import sys

KEYWORDS = set("""let mut const fn function class struct record enum component role behavior from extends with
replaces export import as if else for in while loop match when decide select return break continue
parallel async await task flow entity process then unsafe extern true false own view shared out err
use try catch cli app command val packet using or type where require ensure register bit bits
comptime wrapping saturating trait impl pub asm""".split())

# types that are NOT structs; primitives and collection types are passed by value
PRIMITIVES = set("""Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64 Float Float32 Float64
Bool Str Char Val Unit Never RawPtr""".split())


def collect_structs(root):
    names = set()
    for p in glob.glob(os.path.join(root, '**', '*.dtr'), recursive=True):
        text = open(p, encoding='utf-8').read()
        for m in re.finditer(r'^\s*pub\s+struct\s+([A-Za-z_][A-Za-z_0-9]*)', text, re.M):
            names.add(m.group(1))
    return names


STRUCT_OPEN = re.compile(
    r'pub\s+struct\s+([A-Za-z_][A-Za-z_0-9]*)\s*(<[^>{}]*>)?\s*\{')

# Scalar types are the only ones that take part in the field-name collision.
# Collections, generic applications and user struct types were all verified safe
# by experiment; see the R10 note in the module docstring.
SCALARS = set("""Int Int8 Int16 Int32 Int64 UInt UInt8 UInt16 UInt32 UInt64
Float Float32 Float64 Bool Str Char Val Unit Never RawPtr""".split())


def split_fields(body):
    """Split a struct body into `name: Type` chunks.

    Handles every layout the compiler accepts, including a single-line body
    (`pub struct X { a: Int, b: Str }`) and multi-line bodies with doc comments.
    Splitting respects `<`, `(`, `[` nesting so `Map<Str, Int>` stays one field.
    """
    body = re.sub(r'//[^\n]*', '', body)          # drop comments
    chunks, cur, depth = [], '', 0
    for ch in body:
        if ch in '<([':
            depth += 1
        elif ch in '>)]':
            depth -= 1
        if ch in '\n,' and depth <= 0:
            chunks.append(cur)
            cur = ''
        else:
            cur += ch
    chunks.append(cur)
    return [c.strip() for c in chunks if c.strip()]


def collect_field_types(root):
    """field name -> {declared type: [(path, line, struct)]} for the whole tree.

    The unit of analysis is the entire source tree rather than one file, because
    forgen's field table is global: two files that never mention each other can
    still collide as soon as some third file imports both.
    """
    table = {}
    for p in sorted(glob.glob(os.path.join(root, '**', '*.dtr'), recursive=True)):
        text = open(p, encoding='utf-8').read()
        for m in STRUCT_OPEN.finditer(text):
            sname = m.group(1)
            params = set(re.findall(r'[A-Za-z_][A-Za-z_0-9]*', m.group(2) or ''))
            # walk to the matching close brace
            i, depth = m.end(), 1
            while i < len(text) and depth > 0:
                if text[i] == '{':
                    depth += 1
                elif text[i] == '}':
                    depth -= 1
                i += 1
            body = text[m.end():i - 1]
            line0 = text.count('\n', 0, m.end()) + 1
            for chunk in split_fields(body):
                fm = re.match(r'^([a-z_][a-z_0-9]*)\s*:\s*(\S.*)$', chunk, re.S)
                if not fm:
                    continue
                fname = fm.group(1)
                ftype = re.sub(r'\s+', ' ', fm.group(2).strip())
                if ftype in params:
                    continue  # a declared type parameter never collides
                table.setdefault(fname, {}).setdefault(ftype, []).append(
                    (p, line0, sname))
    return table


def check_field_collisions(root):
    """R11: no field name may be declared by two structs. R10: scalar clash."""
    issues = []
    for fname, types in sorted(collect_field_types(root).items()):
        owners = [s for locs in types.values() for (_, _, s) in locs]
        if len(owners) < 2:
            continue
        detail = '; '.join(
            '%s at %s' % (t, ', '.join('%s:%d' % (pp, ii) for pp, ii, _ in locs))
            for t, locs in sorted(types.items()))
        scalar_clash = len(types) > 1 and any(t in SCALARS for t in types)
        rule = 'R10 scalar field collision' if scalar_clash else 'R11 shared field name'
        for t, locs in sorted(types.items()):
            for pp, ii, sname in locs:
                issues.append((pp, ii,
                               '%s: %s.%s : %s' % (rule, sname, fname, t),
                               detail))
    return issues


SIG = re.compile(
    r'^([ \t]*pub fn\s+[a-z_0-9]+\s*\()(.*?)(\)\s*(?:->\s*[^\n{]+)?\s*(?:\{|=>))',
    re.S | re.M)


def split_top_level(paramstr):
    parts, depth, cur = [], 0, ''
    for ch in paramstr:
        if ch in '<([':
            depth += 1
        elif ch in '>)]':
            depth -= 1
        if ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


def fix_view(params, structs):
    out = []
    for p in split_top_level(params):
        raw = p.strip()
        if not raw:
            continue
        m = re.match(r'^(?:(view|mut_view|own|shared)\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(.+)$', raw, re.S)
        if not m:
            out.append(' ' + raw)
            continue
        mod, name, typ = m.group(1), m.group(2), m.group(3).strip()
        base = re.match(r'^([A-Za-z_][A-Za-z_0-9]*)', typ)
        if base and base.group(1) in structs and mod is None:
            out.append(' view ' + name + ': ' + typ)
        else:
            out.append(' ' + raw)
    return ','.join(out)


def apply_fixes(path, text, structs):
    changed = False

    def repl(m):
        return m.group(1) + fix_view(m.group(2), structs) + m.group(3)

    new = SIG.sub(repl, text)
    if new != text:
        changed = True
        text = new

    # R2: bool-returning string predicates
    for fn in ('str_starts_with', 'str_ends_with', 'str_contains'):
        pattern = re.compile(r'(?<!==\s)(?<!=)' + fn + r'\(([^()]*)\)(?!\s*==)')
        def r2(m):
            return fn + '(' + m.group(1) + ') == 1'
        n2 = pattern.sub(r2, text)
        if n2 != text:
            changed = True
            text = n2

    return text, changed


def check(path, text):
    issues = []
    for i, line in enumerate(text.splitlines(), 1):
        code = line.split('//')[0]
        if re.search(r'=\s*if\s', code):
            issues.append((path, i, 'R4 if-expression', line.strip()))
        if re.search(r'(?<![|])\|(?![|>])', code) or re.search(r'(?<!&)&(?!&)', code):
            issues.append((path, i, 'R5 bitwise operator', line.strip()))
        if re.match(r'^\s*pub\s+[a-z_][a-z_0-9]*\s*:', code):
            issues.append((path, i, 'R6 pub struct field', line.strip()))
        if re.match(r'^\s*pub\s+let\s', code):
            issues.append((path, i, 'R7 pub top-level let', line.strip()))
        if re.search(r'->\s*[A-Z][A-Za-z_0-9]*!\s*\{', code):
            issues.append((path, i, 'R9 result shorthand', line.strip()))
        for m in re.finditer(r'\b(?:mut|let)\s+([a-z_][a-z_0-9]*)\s*=', code):
            if m.group(1) in KEYWORDS:
                issues.append((path, i, 'R3 keyword identifier: ' + m.group(1), line.strip()))
        for m in re.finditer(r'\(\s*(?:mut_view|view)?\s*([a-z_][a-z_0-9]*)\s*:\s*[A-Z]', code):
            if m.group(1) in KEYWORDS:
                issues.append((path, i, 'R3 keyword param: ' + m.group(1), line.strip()))
    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root', nargs='?', default='src')
    ap.add_argument('--fix', action='store_true')
    args = ap.parse_args()

    structs = collect_structs(args.root)
    files = sorted(glob.glob(os.path.join(args.root, '**', '*.dtr'), recursive=True))

    all_issues = []
    fixed = []
    for p in files:
        text = open(p, encoding='utf-8').read()
        if args.fix:
            new, changed = apply_fixes(p, text, structs)
            if changed:
                open(p, 'w', encoding='utf-8').write(new)
                fixed.append(p)
                text = new
        all_issues.extend(check(p, text))

    all_issues.extend(check_field_collisions(args.root))

    if fixed:
        print('fixed:')
        for p in fixed:
            print('  ' + p)

    if all_issues:
        print('\nissues:')
        for p, i, rule, line in all_issues:
            print('  %s:%d  %s\n      %s' % (p, i, rule, line))
        return 1

    print('style check clean (%d files, %d struct types)' % (len(files), len(structs)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
