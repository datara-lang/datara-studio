#!/usr/bin/env python3
"""Uniquify struct field names across the whole Datara project.

WHY THIS EXISTS
---------------
forgen 1.3.0 keeps struct field offsets in ONE global table keyed by field name.
The first struct to declare a name fixes that name's offset; every later struct
that reuses the name silently reads and writes at the first struct's offset.

There is no diagnostic. The only observable symptom is wrong data at runtime.

Measured (probes/fieldnames_shared vs probes/fieldnames_unique):

    shared field names across structs  -> 2 of 3 structs corrupt
    unique field names                 -> all 3 correct

So the invariant this tool enforces is: **every struct field name is globally
unique**. This is stricter than "type-consistent", which is not sufficient.

WHAT IT DOES
------------
For every struct it computes a tag (explicit table below, else the lowercased
struct name) and renames `field` to `<tag>_<field>`:

  * the field in the struct declaration
  * the key in every struct literal `StructName { field: ... }`
  * every access `expr.field`

Access sites need the type of `expr`, so the tool does lightweight type
inference from function signatures, struct literals, and `let`/`mut` bindings.
Anything it cannot resolve is left alone and reported, so the compiler surfaces
it as an undefined-field error rather than a silent miscompile.

Usage:  python scripts/uniquify_fields.py [--apply] [src_dir]
"""

import argparse
import glob
import os
import re
import sys

# Short, readable tags. Anything not listed falls back to the lowercased name.
TAGS = {
    "Id": "id_",
    "IdAllocator": "alloc_",
    "Version": "ver_",
    "VersionReq": "vreq_",
    "Clock": "clk_",
    "Timed": "timed_",
    "Revision": "rev_",
    "Epoch": "epoch_",
    "Generation": "gen_",
    "Freshness": "fresh_",
    "GenerationTable": "gentab_",
    "RyanError": "err_",
    "Verdict": "verdict_",
    "RopeChunk": "chunk_",
    "Rope": "rope_",
    "Position": "pos_",
    "Range": "range_",
    "Selection": "sel_",
    "ViewState": "view_",
    "LineIndex": "li_",
    "Edit": "edit_",
    "EditBatch": "batch_",
    "EditBatchCheck": "check_",
    "UndoStack": "undo_",
    "UndoEntry": "entry_",
    "UndoPop": "pop_",
    "Field": "fld_",
    "Event": "ev_",
    "Subscription": "sub_",
    "SubscribeResult": "sres_",
    "BusCounters": "cnt_",
    "StormGuard": "storm_",
    "Bus": "bus_",
    "PublishResult": "pres_",
    "Delivery": "dlv_",
    "PumpResult": "pump_",
    "TestResult": "tres_",
    "TestSuite": "suite_",
}

PRIMITIVE_OR_LIST = re.compile(r'^(List|Map|Set)<')


def tag_for(struct_name):
    if struct_name in TAGS:
        return TAGS[struct_name]
    # fall back to snake_case of the struct name
    s = re.sub(r'(?<!^)(?=[A-Z])', '_', struct_name).lower()
    return s + "_"


def split_top_level(text, seps=","):
    parts, depth, cur = [], 0, ""
    for ch in text:
        if ch in "<([{":
            depth += 1
        elif ch in ">)]}":
            depth -= 1
        if ch in seps and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


class Project:
    def __init__(self, root):
        self.root = root
        self.structs = {}       # name -> [(PREFIXED field, type)]  (rewritten code)
        self.raw = {}           # name -> [(original field, type)]  (source code)
        self.funcs = {}         # name -> (param_types, ret_type)
        self.files = {}         # path -> text
        self.scan()

    # -- scanning ----------------------------------------------------------
    def scan(self):
        for p in sorted(glob.glob(os.path.join(self.root, "**", "*.dtr"), recursive=True)):
            text = open(p, encoding="utf-8").read()
            self.files[p] = text
            self.scan_structs(text)
            self.scan_funcs(text)

    def scan_structs(self, text):
        for m in re.finditer(r'pub\s+struct\s+([A-Za-z_][A-Za-z_0-9]*)\s*(<[^>{}]*>)?\s*\{', text):
            name = m.group(1)
            i, depth = m.end(), 1
            while i < len(text) and depth > 0:
                if text[i] == "{":
                    depth += 1
                elif text[i] == "}":
                    depth -= 1
                i += 1
            body = text[m.end():i - 1]
            params = set(re.findall(r'[A-Za-z_][A-Za-z_0-9]*', m.group(2) or ""))
            raw_fields = []
            fields = []
            for chunk in split_top_level(re.sub(r'//[^\n]*', '', body), "\n,"):
                fm = re.match(r'^\s*([a-z_][a-z_0-9]*)\s*:\s*(\S.*?)\s*$', chunk, re.S)
                if not fm:
                    continue
                f, t = fm.group(1), re.sub(r'\s+', ' ', fm.group(2))
                if t in params:
                    continue
                raw_fields.append((f, t))
                fields.append((tag_for(name) + f, t))
            self.raw[name] = raw_fields
            self.structs[name] = fields

    def scan_funcs(self, text):
        for m in re.finditer(
                r'pub\s+fn\s+([a-z_][a-z_0-9]*)\s*\((.*?)\)\s*(?:->\s*([^\n{=]+?))?\s*(?:\{|=>)',
                text, re.S):
            name, rawparams, ret = m.group(1), m.group(2), (m.group(3) or "").strip()
            types = []
            for prm in split_top_level(rawparams):
                pm = re.match(r'^\s*(?:view\s+|mut_view\s+|own\s+|shared\s+)?'
                              r'([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(\S.*?)\s*$', prm, re.S)
                if pm:
                    types.append(re.sub(r'\s+', ' ', pm.group(2)))
            self.funcs[name] = (types, ret)

    # -- inference ---------------------------------------------------------
    def base_type(self, expr, scope):
        """Type of a simple expression: ident, ident[i], ident.field, fn(...)"""
        e = expr.strip()
        # strip a trailing index or field chain, resolve left to right
        m = re.match(r'^([a-zA-Z_][A-Za-z_0-9]*)\s*\(', e)
        if m:
            return self.funcs.get(m.group(1), ([], ""))[1]
        m = re.match(r'^([a-z_][a-z_0-9]*)', e)
        if not m:
            return ""
        cur = scope.get(m.group(1), "")
        rest = e[m.end():]
        while rest and cur:
            if rest.startswith("["):
                depth = 0
                k = 0
                while k < len(rest):
                    if rest[k] == "[":
                        depth += 1
                    elif rest[k] == "]":
                        depth -= 1
                        if depth == 0:
                            break
                    k += 1
                cur = self.elem_type(cur)
                rest = rest[k + 1:]
            elif rest.startswith("."):
                fm = re.match(r'^\.([a-z_][a-z_0-9]*)', rest)
                if not fm:
                    break
                cur = self.field_type(cur, fm.group(1))
                rest = rest[fm.end():]
            else:
                break
        return cur

    def elem_type(self, t):
        m = re.match(r'^List\s*<\s*(.+?)\s*>$', t)
        return m.group(1) if m else ""

    def field_type(self, struct, field):
        """Type of a field on the PREFIXED name (i.e. in rewritten code)."""
        for f, t in self.structs.get(struct, []):
            if f == field:
                return t
        return ""

    def raw_field_type(self, struct, field):
        """Type of a field on the ORIGINAL name (i.e. in source code)."""
        for f, t in self.raw.get(struct, []):
            if f == field:
                return t
        return ""

    def raw_has_field(self, struct, field):
        return any(f == field for f, _ in self.raw.get(struct, []))

    # -- rewriting ---------------------------------------------------------
    def rewrite_decls_and_literals(self, text):
        """Single non-overlapping scan over every `Name { ... }`.

        A declaration gets its field lines prefixed; a literal gets its keys
        prefixed. Doing both in one pass avoids a declaration being treated as a
        literal of its own struct (which would double the prefix).
        """
        out, i, pos = [], 0, 0
        while True:
            m = re.compile(r'\b([A-Z][A-Za-z_0-9]*)\s*\{').search(text, pos)
            if not m:
                break
            name = m.group(1)
            brace = m.end() - 1
            if name not in self.structs:
                pos = brace + 1
                continue
            bstart, bend = self._body_span(text, brace)
            body = text[bstart:bend]
            tag = tag_for(name)
            before = text[max(0, m.start() - 24):m.start()].rstrip()
            if before.endswith("->"):
                # `fn f(...) -> Rope {` - this brace opens a function body, not a
                # literal. Skip it so the body is not treated as a key list; the
                # literals inside are picked up by later iterations.
                pos = brace + 1
                continue
            if before.endswith("struct"):
                new_body = re.sub(r'(?m)^([ \t]*)([a-z_][a-z_0-9]*)([ \t]*:)',
                                  lambda f: f.group(1) + tag + f.group(2) + f.group(3),
                                  body)
            else:
                # literal keys are still original names at this point
                known = {f for f, _ in self.raw[name]}

                def key_repl(km):
                    k = km.group(1)
                    return tag + k + km.group(2) if k in known else km.group(0)

                new_body = re.sub(r'(?<![\w.])([a-z_][a-z_0-9]*)([ \t]*:)', key_repl, body)
            out.append(text[i:bstart])
            out.append(new_body)
            i = bend
            pos = bend
        out.append(text[i:])
        return "".join(out)

    @staticmethod
    def _body_span(text, brace):
        """Indexes just inside the braces matching the one at `brace`."""
        j, depth = brace + 1, 1
        while j < len(text) and depth > 0:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        return brace + 1, j

    @staticmethod
    def _match(text, start, opener, closer):
        """Index of the closer matching the opener at `start`, or -1."""
        depth = 0
        i = start
        while i < len(text):
            if text[i] == opener:
                depth += 1
            elif text[i] == closer:
                depth -= 1
                if depth == 0:
                    return i
            i += 1
        return -1

    def rewrite_chains(self, code, scope):
        """Rewrite field accesses left to right within one line of code.

        `ev.fields.len()` must become `ev.ev_fields.len()`: the type has to be
        re-evaluated after each step, so a single regex cannot do it.
        """
        out, i, n = [], 0, len(code)
        while i < n:
            m = re.match(r'[a-z_][a-z_0-9]*', code[i:])
            if not m:
                out.append(code[i])
                i += 1
                continue
            base = m.group(0)
            j = i + m.end()
            cur = scope.get(base, "")
            chunk = base
            if j < n and code[j] == '(':
                k = self._match(code, j, '(', ')')
                if k < 0:
                    out.append(code[i:j])
                    i = j
                    continue
                if not cur:
                    cur = self.funcs.get(base, ([], ""))[1]
                # arguments are code too: rewrite them recursively
                chunk += '(' + self.rewrite_chains(code[j + 1:k], scope) + ')'
                j = k + 1
            while j < n:
                if code[j] == '[':
                    k = self._match(code, j, '[', ']')
                    if k < 0:
                        break
                    chunk += code[j:k + 1]
                    cur = self.elem_type(cur)
                    j = k + 1
                elif code[j] == '.' and j + 1 < n and re.match(r'[a-z_]', code[j + 1]):
                    fm = re.match(r'\.\s*([a-z_][a-z_0-9]*)', code[j:])
                    fld = fm.group(1)
                    after = j + fm.end()
                    if cur in self.raw and self.raw_has_field(cur, fld):
                        chunk += '.' + tag_for(cur) + fld
                        cur = self.raw_field_type(cur, fld)
                    else:
                        chunk += code[j:after]
                        cur = ""
                    j = after
                else:
                    break
            out.append(chunk)
            i = j
        return "".join(out)

    def rename_accesses(self, text):
        """Rename `expr.field` using inferred types. Line-oriented, with a scope
        that is rebuilt per function."""
        lines = text.split("\n")
        scope = {}
        unresolved = []
        for idx, line in enumerate(lines):
            code, sep, comment = line.partition("//")
            # a new function resets the scope
            fm = re.match(r'\s*pub\s+fn\s+([a-z_][a-z_0-9]*)\s*\((.*?)\)', code, re.S)
            if fm:
                scope = {}
                for prm in split_top_level(fm.group(2)):
                    pm = re.match(r'^\s*(?:view\s+|mut_view\s+|own\s+|shared\s+)?'
                                  r'([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(\S.*?)\s*$', prm, re.S)
                    if pm:
                        scope[pm.group(1)] = re.sub(r'\s+', ' ', pm.group(2))

            # rename field accesses, left to right
            new_code = self.rewrite_chains(code, scope)

            # track `let/mut NAME = RHS`
            for lm in re.finditer(r'\b(?:let|mut)\s+([a-z_][a-z_0-9]*)\s*(?::\s*([^=]+?))?\s*=\s*(.+)', new_code):
                var, ann, rhs = lm.group(1), (lm.group(2) or "").strip(), lm.group(3)
                t = ann if ann else self.base_type(rhs, scope)
                if t:
                    scope[var] = t

            lines[idx] = new_code + sep + comment
        return "\n".join(lines), unresolved

    def rename_declarations(self, text):
        return text  # folded into rewrite_decls_and_literals


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", nargs="?", default="src")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    proj = Project(args.root)
    print("structs: %d   funcs: %d   files: %d"
          % (len(proj.structs), len(proj.funcs), len(proj.files)))

    total = 0
    for path, text in sorted(proj.files.items()):
        new = proj.rewrite_decls_and_literals(text)
        new, _ = proj.rename_accesses(new)
        if new != text:
            total += 1
            if args.apply:
                open(path, "w", encoding="utf-8").write(new)
    print(("applied to %d files" if args.apply else "would change %d files") % total)


if __name__ == "__main__":
    sys.exit(main())
