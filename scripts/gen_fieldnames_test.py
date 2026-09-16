#!/usr/bin/env python3
"""Test the hypothesis: field names must be globally unique across the project.

probes/layout_iso shows every layout is correct in isolation.
probes/bool_field shows the same layouts become wrong when they coexist.
The candidate rule is that forgen keeps ONE global name -> offset table, so two
structs that declare the same field name at different offsets corrupt each
other.

This generator emits the same five layouts twice:
  * shared/  - field names collide across structs (expected: broken)
  * unique/  - every field name is prefixed per struct (expected: correct)
"""

import pathlib

BASE = {
    "A": [
        ("id", "Int"), ("kind", "Str"), ("subsystem", "Str"), ("priority", "Int"),
        ("scope", "Str"), ("scope_id", "Int"), ("deferred_mode", "Bool"),
        ("cancelled", "Bool"), ("delivery_count", "Int"), ("muted", "List<Str>"),
    ],
    "B": [
        ("id", "Int"), ("kind", "Str"), ("scope_id", "Int"),
        ("deferred_mode", "Bool"), ("cancelled", "Bool"),
    ],
    "C": [
        ("id", "Int"), ("kind", "Str"), ("scope_id", "Int"),
        ("deferred_mode", "Bool"), ("cancelled", "Bool"), ("delivery_count", "Int"),
    ],
}


def literal_value(field, typ, prefix):
    stem = field
    if prefix and stem.startswith(prefix):
        stem = stem[len(prefix):]
    return {
        "id": "id", "kind": "kind", "scope_id": "scope_id",
        "subsystem": '""', "priority": "10", "scope": '"document"', "muted": "[]",
    }.get(stem, "false" if typ == "Bool" else "0")


def build(unique):
    out = []
    if unique:
        out.append("//! GENERATED: every field name is prefixed per struct.")
    else:
        out.append("//! GENERATED: field names are shared between structs.")
    out.append("")
    names = {}
    for tag, fields in BASE.items():
        prefix = tag.lower() + "_" if unique else ""
        names[tag] = [(prefix + f, t) for f, t in fields]

    for tag, fields in names.items():
        out.append("pub struct S%s {" % tag)
        for f, t in fields:
            out.append("    %s: %s" % (f, t))
        out.append("}")
        out.append("")
        out.append("pub fn s%s_new(id: Int, kind: Str, scope_id: Int) -> S%s {" % (tag, tag))
        out.append("    return S%s {" % tag)
        for i, (f, t) in enumerate(fields):
            comma = "," if i < len(fields) - 1 else ""
            out.append("        %s: %s%s" % (f, literal_value(f, t, tag.lower() + "_"), comma))
        out.append("    }")
        out.append("}")
        out.append("")
        for f, t in fields:
            if t == "Bool":
                out.append("fn s%s_get_%s(view x: S%s) -> Bool => x.%s" % (tag, f, tag, f))
            elif t == "Int" and f.endswith("scope_id"):
                out.append("fn s%s_get_scope_id(view x: S%s) -> Int => x.%s" % (tag, tag, f))
        out.append("")

    out.append("fn b2s(v: Bool) -> Str {")
    out.append('    mut res = "false"')
    out.append("    if v {")
    out.append('        res = "true"')
    out.append("    }")
    out.append("    return res")
    out.append("}")
    out.append("")
    out.append("fn main() {")
    out.append("    mut i = 0")
    for tag, fields in names.items():
        bools = [f for f, t in fields if t == "Bool"]
        sid = [f for f, t in fields if t == "Int" and f.endswith("scope_id")][0]
        out.append('    println("=== S%s ===")' % tag)
        out.append("    mut xs: List<S%s> = []" % tag)
        out.append("    i = 0")
        out.append("    while i < 3 {")
        out.append('        xs = xs.push(s%s_new(i, "K", i))' % tag)
        out.append("        i = i + 1")
        out.append("    }")
        out.append("    i = 0")
        out.append("    while i < xs.len() {")
        out.append("        let x = xs[i]")
        pieces = ['"i=" + int_to_str(i)']
        pieces.append('" scope_id=" + int_to_str(s%s_get_scope_id(x))' % tag)
        for f in bools:
            pieces.append('" %s=" + b2s(s%s_get_%s(x))' % (f, tag, f))
        out.append("        println(" + " + ".join(pieces) + ")")
        out.append("        i = i + 1")
        out.append("    }")
    out.append("}")
    out.append("")
    return "\n".join(out)


for mode, unique in (("shared", False), ("unique", True)):
    d = pathlib.Path("probes") / ("fieldnames_" + mode)
    d.mkdir(parents=True, exist_ok=True)
    (d / "main.dtr").write_text(build(unique), encoding="utf-8")
    print("wrote", d / "main.dtr")
