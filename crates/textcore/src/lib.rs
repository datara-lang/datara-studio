//! Datara Studio :: text core (wasm32)
//!
//! The document model and the lexer for the editor, in Rust, compiled to
//! WebAssembly. Three jobs, each chosen because it is genuinely faster here than
//! in JavaScript:
//!
//!   1. **document storage** - one `String` plus an incrementally maintained
//!      list of line-start byte offsets. Insert and delete splice the line
//!      index instead of rebuilding it, so an edit costs O(lines touched + new
//!      newlines) rather than O(document).
//!   2. **offset arithmetic** - line/column, byte <-> UTF-16 code unit. The
//!      browser addresses text in UTF-16 while the document is UTF-8, so every
//!      caret and selection needs this conversion, on every keystroke.
//!   3. **lexing** - Datara tokens for syntax highlighting. Re-highlighting a
//!      10k-line file in JavaScript on every keystroke is the single biggest
//!      cost in the editor; here it is a linear byte scan.
//!
//! No `wasm-bindgen`, deliberately. The ABI is a flat C one over linear memory:
//! JavaScript writes UTF-8 into a scratch buffer obtained from `alloc`, calls a
//! function with `(ptr, len)`, and reads results either as a return value or as
//! a `Uint32Array` view over `lex_ptr()`. That keeps the binary small, removes a
//! toolchain dependency, and makes the boundary crossing count explicit - which
//! matters, because boundary crossings are where wasm speed is lost.
//!
//! The incremental line index is verified against a full rebuild by
//! `doc_verify`, which the JavaScript side asserts in a self-test. A fast path
//! that is never checked against the slow path is a bug waiting to happen.

use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};

// ---------------------------------------------------------------------------
// token kinds, mirrored in ui/app.js
// ---------------------------------------------------------------------------

const T_PLAIN: u32 = 0;
const T_KEYWORD: u32 = 1;
const T_TYPE: u32 = 2;
const T_STRING: u32 = 3;
const T_COMMENT: u32 = 4;
const T_NUMBER: u32 = 5;
const T_FUNCTION: u32 = 6;
const T_PUNCT: u32 = 7;
// A `{...}` hole inside an `fmt"..."` literal. It is the one place a variable
// name appears inside a string, so it gets its own kind rather than being
// painted as string text.
const T_INTERP: u32 = 8;

const KEYWORDS: &[&str] = &[
    "fn", "let", "mut", "const", "class", "struct", "behavior", "trait", "impl", "if", "else",
    "match", "when", "decide", "for", "in", "while", "loop", "return", "use", "import", "from",
    "as", "export", "extern", "unsafe", "own", "view", "mut_view", "shared", "out", "err", "try",
    "catch", "parallel", "async", "await", "with", "comptime", "register", "type", "entity",
    "process", "component", "role", "packet", "require", "ensure", "val", "this", "bits", "where",
];

const TYPES: &[&str] = &[
    "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
    "Float", "Float32", "Float64", "Bool", "Str", "Char", "Unit", "Never", "RawPtr", "List", "Map",
    "Set", "Maybe", "Outcome", "Capability", "Result", "Option", "Self", "FileRead", "FileWrite",
    "ProcessExec", "NetworkConnect", "NetworkListen", "SystemClock", "SystemEnv",
];

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

struct Doc {
    text: String,
    /// Byte offset where each line begins. Always starts with 0.
    lines: Vec<u32>,
}

impl Doc {
    fn new() -> Doc {
        Doc { text: String::new(), lines: vec![0] }
    }

    /// Full rebuild. Used on load and as the reference for `verify`.
    fn rebuild_lines(&mut self) {
        self.lines.clear();
        self.lines.push(0);
        for (i, b) in self.text.as_bytes().iter().enumerate() {
            if *b == b'\n' {
                self.lines.push((i + 1) as u32);
            }
        }
    }

    fn line_count(&self) -> u32 {
        self.lines.len() as u32
    }

    fn line_of(&self, byte: u32) -> u32 {
        // binary search for the last line start <= byte
        match self.lines.binary_search(&byte) {
            Ok(i) => i as u32,
            Err(i) => (i.saturating_sub(1)) as u32,
        }
    }

    /// Insert `s` at byte offset `pos`, maintaining the line index incrementally.
    fn insert(&mut self, pos: u32, s: &str) {
        let pos = (pos as usize).min(self.text.len());
        let added = s.len() as u32;
        let line = self.line_of(pos as u32) as usize;
        let line_start = self.lines[line] as usize;

        self.text.insert_str(pos, s);

        // every existing line start after the insertion point shifts
        for l in self.lines.iter_mut().skip(line + 1) {
            *l += added;
        }

        // new line starts from newlines inside the inserted text
        let mut fresh: Vec<u32> = Vec::new();
        for (i, b) in s.as_bytes().iter().enumerate() {
            if *b == b'\n' {
                fresh.push(pos as u32 + i as u32 + 1);
            }
        }
        // a line start that lands exactly on the old `line_start` is a no-op;
        // otherwise splice the new ones in after `line`
        if !fresh.is_empty() {
            let at = line + 1;
            for (k, v) in fresh.into_iter().enumerate() {
                self.lines.insert(at + k, v);
            }
        }
        // invariant: lines[0] == 0
        if self.lines.is_empty() || self.lines[0] != 0 {
            self.lines.insert(0, 0);
        }
        let _ = line_start;
    }

    /// Delete `len` bytes at byte offset `pos`, maintaining the line index.
    fn delete(&mut self, pos: u32, len: u32) {
        let start = (pos as usize).min(self.text.len());
        let end = (start + len as usize).min(self.text.len());
        if start >= end {
            return;
        }
        let removed = (end - start) as u32;
        let first_line = self.line_of(pos);

        self.text.replace_range(start..end, "");

        // drop line starts strictly inside the removed range, shift the rest
        let mut kept: Vec<u32> = Vec::with_capacity(self.lines.len());
        for (i, l) in self.lines.iter().enumerate() {
            if i as u32 <= first_line {
                kept.push(*l);
            } else if *l > pos + removed {
                kept.push(*l - removed);
            } else if *l > pos {
                // falls inside the removed range: the line is gone
            } else {
                kept.push(*l);
            }
        }
        self.lines = kept;
        if self.lines.is_empty() {
            self.lines.push(0);
        }
    }

    /// UTF-16 code unit offset -> UTF-8 byte offset.
    fn utf16_to_byte(&self, u16off: u32) -> u32 {
        let mut u16_seen = 0u32;
        let bytes = self.text.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if u16_seen >= u16off {
                return i as u32;
            }
            let (w, adv) = utf16_width(bytes[i]);
            u16_seen += w;
            i += adv;
        }
        bytes.len() as u32
    }

    /// UTF-8 byte offset -> UTF-16 code unit offset.
    fn byte_to_utf16(&self, byteoff: u32) -> u32 {
        let bytes = self.text.as_bytes();
        let end = (byteoff as usize).min(bytes.len());
        let mut u16_seen = 0u32;
        let mut i = 0usize;
        while i < end {
            let (w, adv) = utf16_width(bytes[i]);
            u16_seen += w;
            i += adv;
        }
        u16_seen
    }

    /// Rewrite the packed tokens in place so that `start` and `len` are UTF-16
    /// code unit offsets rather than UTF-8 byte offsets, in one forward pass over
    /// the document.
    ///
    /// **Why this has to happen at all.** The document is UTF-8 and the lexer
    /// walks bytes, so the offsets it produces are byte offsets. The interface is
    /// JavaScript, so the string it slices is UTF-16. The two agree exactly while
    /// the document is ASCII and stop agreeing at the first non-ASCII character,
    /// after which `text.slice(start, start + len)` returns text shifted by the
    /// number of extra bytes seen so far.
    ///
    /// Measured on this project's own source, before the fix - a doc comment
    /// followed by code:
    ///
    /// ```text
    /// // Список задач
    /// let имя = 1
    /// ```
    ///
    /// produced a *comment* token whose text was `"// Список задач\nlet имя = "`:
    /// the comment ran past its own newline and coloured the next line as a
    /// comment. `explorer.dtr` has Russian in it, so opening the studio's own
    /// source showed this.
    ///
    /// **Starts are converted; lengths are recomputed.** A length is a byte count
    /// too, and converting it independently would need a second lookup per token.
    /// The tokens tile the document exactly - every branch advances `plain_from`
    /// and the final `push_plain_span` closes the gap - so a length is simply the
    /// distance to the next start, and the last one is the distance to the end.
    /// One subtraction instead of one scan.
    ///
    /// **Why one pass rather than a call per token.** `byte_to_utf16` is
    /// O(offset), so asking it once per token is O(n * tokens) - tens of millions
    /// of byte visits per keystroke on a 10k-line file. The token starts are
    /// already in non-decreasing order, so a single walk resolves all of them at
    /// once: O(n + tokens). Doing it here rather than by calling
    /// `doc_byte_to_utf16` from JavaScript per token also keeps the boundary
    /// crossings at one, which the module note above says is the thing that
    /// actually costs.
    fn rewrite_offsets_as_utf16(&self, buf: &mut [u32]) {
        let bytes = self.text.as_bytes();
        let n = bytes.len();
        let count = buf.len() / 3;
        if count == 0 {
            return;
        }

        let mut cursor = 0usize; // byte offset already accounted for
        let mut u16_seen = 0u32; // the UTF-16 offset `cursor` corresponds to
        for i in 0..count {
            let want = buf[i * 3] as usize;
            if want < cursor {
                // Out of order. The lexer never emits that, but if it ever did, a
                // correct offset is worth the O(offset) rescan - a wrong colour
                // is a cosmetic bug, a wrong offset moves text.
                buf[i * 3] = self.byte_to_utf16(buf[i * 3]);
                continue;
            }
            while cursor < want && cursor < n {
                let (w, adv) = utf16_width(bytes[cursor]);
                u16_seen += w;
                cursor += adv;
            }
            buf[i * 3] = u16_seen;
        }

        // The walk stopped at the last token's start; finish it for the end.
        while cursor < n {
            let (w, adv) = utf16_width(bytes[cursor]);
            u16_seen += w;
            cursor += adv;
        }
        let total = u16_seen;

        for i in 0..count {
            let next = if i + 1 < count { buf[(i + 1) * 3] } else { total };
            buf[i * 3 + 1] = next - buf[i * 3];
        }
    }
}

/// How wide the UTF-8 sequence starting with `b` is: `(UTF-16 code units, bytes)`.
///
/// Astral-plane scalars are two UTF-16 units, which is the entire reason the
/// byte <-> UTF-16 conversion has to exist rather than being a subtraction.
fn utf16_width(b: u8) -> (u32, usize) {
    if b < 0x80 {
        (1, 1)
    } else if b >> 5 == 0b110 {
        (1, 2)
    } else if b >> 4 == 0b1110 {
        (1, 3)
    } else if b >> 3 == 0b11110 {
        (2, 4) // astral plane: one scalar, two UTF-16 units
    } else {
        (1, 1) // invalid byte: advance one
    }
}

static mut DOCS: Vec<Doc> = Vec::new();
static mut LEXBUF: Vec<u32> = Vec::new();

fn docs() -> &'static mut Vec<Doc> {
    unsafe { &mut *std::ptr::addr_of_mut!(DOCS) }
}
fn lexbuf() -> &'static mut Vec<u32> {
    unsafe { &mut *std::ptr::addr_of_mut!(LEXBUF) }
}

// ---------------------------------------------------------------------------
// scratch memory
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(n: u32) -> u32 {
    let layout = match Layout::from_size_align(n.max(1) as usize, 8) {
        Ok(l) => l,
        Err(_) => return 0,
    };
    unsafe { rust_alloc(layout) as u32 }
}

#[no_mangle]
pub extern "C" fn dealloc(p: u32, n: u32) {
    if p == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(n.max(1) as usize, 8) {
        unsafe { rust_dealloc(p as *mut u8, layout) }
    }
}

#[no_mangle]
pub extern "C" fn textcore_version() -> u32 {
    1
}

// ---------------------------------------------------------------------------
// document ABI
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn doc_new() -> u32 {
    let d = docs();
    d.push(Doc::new());
    (d.len() - 1) as u32
}

#[no_mangle]
pub extern "C" fn doc_free(h: u32) {
    let d = docs();
    if let Some(slot) = d.get_mut(h as usize) {
        slot.text.clear();
        slot.lines.clear();
        slot.lines.push(0);
    }
}

/// Replace the whole document. Returns the byte length.
#[no_mangle]
pub extern "C" fn doc_set(h: u32, ptr: u32, len: u32) -> u32 {
    let s = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let text = String::from_utf8_lossy(s).into_owned();
    let d = docs();
    match d.get_mut(h as usize) {
        Some(slot) => {
            slot.text = text;
            slot.rebuild_lines();
            slot.text.len() as u32
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn doc_len(h: u32) -> u32 {
    docs().get(h as usize).map(|d| d.text.len() as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn doc_line_count(h: u32) -> u32 {
    docs().get(h as usize).map(|d| d.line_count()).unwrap_or(0)
}

/// Copy the document into `out` (capacity `cap`). Returns bytes written.
#[no_mangle]
pub extern "C" fn doc_get(h: u32, out: u32, cap: u32) -> u32 {
    let d = match docs().get(h as usize) {
        Some(d) => d,
        None => return 0,
    };
    let n = d.text.len().min(cap as usize);
    unsafe {
        std::ptr::copy_nonoverlapping(d.text.as_ptr(), out as *mut u8, n);
    }
    n as u32
}

#[no_mangle]
pub extern "C" fn doc_insert(h: u32, pos: u32, ptr: u32, len: u32) -> u32 {
    let s = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let text = String::from_utf8_lossy(s).into_owned();
    match docs().get_mut(h as usize) {
        Some(d) => {
            d.insert(pos, &text);
            d.text.len() as u32
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn doc_delete(h: u32, pos: u32, len: u32) -> u32 {
    match docs().get_mut(h as usize) {
        Some(d) => {
            d.delete(pos, len);
            d.text.len() as u32
        }
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn doc_line_start(h: u32, line: u32) -> u32 {
    match docs().get(h as usize) {
        Some(d) => *d.lines.get(line as usize).unwrap_or(&0),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn doc_line_of(h: u32, byte: u32) -> u32 {
    docs().get(h as usize).map(|d| d.line_of(byte)).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn doc_utf16_to_byte(h: u32, u16off: u32) -> u32 {
    docs().get(h as usize).map(|d| d.utf16_to_byte(u16off)).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn doc_byte_to_utf16(h: u32, byteoff: u32) -> u32 {
    docs().get(h as usize).map(|d| d.byte_to_utf16(byteoff)).unwrap_or(0)
}

/// Find `needle` at or after `from`. Returns the byte offset or 0xFFFFFFFF.
#[no_mangle]
pub extern "C" fn doc_find(h: u32, ptr: u32, len: u32, from: u32) -> u32 {
    let needle = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let needle = String::from_utf8_lossy(needle);
    let d = match docs().get(h as usize) {
        Some(d) => d,
        None => return u32::MAX,
    };
    let start = (from as usize).min(d.text.len());
    match d.text[start..].find(needle.as_ref()) {
        Some(i) => (start + i) as u32,
        None => u32::MAX,
    }
}

/// Recompute the line index from scratch and report whether the incremental one
/// agreed. Returns 1 for agreement, 0 for divergence. The JavaScript self-test
/// calls this after every edit, so the fast path is never trusted blindly.
#[no_mangle]
pub extern "C" fn doc_verify(h: u32) -> u32 {
    let d = match docs().get(h as usize) {
        Some(d) => d,
        None => return 0,
    };
    let mut reference: Vec<u32> = vec![0];
    for (i, b) in d.text.as_bytes().iter().enumerate() {
        if *b == b'\n' {
            reference.push((i + 1) as u32);
        }
    }
    if reference == d.lines {
        1
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b >= 0x80
}

fn is_ident_body(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

fn is_punct(b: u8) -> bool {
    matches!(
        b,
        b'{' | b'}' | b'(' | b')' | b'[' | b']' | b':' | b';' | b',' | b'.' | b'=' | b'+' | b'-'
            | b'*' | b'/' | b'<' | b'>' | b'!' | b'&' | b'|' | b'%' | b'@' | b'#' | b'?' | b'~' | b'^'
    )
}

fn push_token(buf: &mut Vec<u32>, start: usize, len: usize, kind: u32) {
    if len == 0 {
        return;
    }
    buf.push(start as u32);
    buf.push(len as u32);
    buf.push(kind);
}

fn push_plain_span(buf: &mut Vec<u32>, from: &mut usize, to: usize) {
    if to > *from {
        push_token(buf, *from, to - *from, T_PLAIN);
        *from = to;
    }
}

/// Is the string literal starting at `quote` written as `fmt"..."`?
///
/// The language interpolates `{...}` in an `fmt` literal and nowhere else. That
/// was measured, not assumed - `"{name}"` prints `{name}` and `fmt"{name}"`
/// prints the value - so painting the braces in a plain string would tell the
/// reader something untrue. Which literal it is therefore belongs in the lexer
/// rather than in a guess at render time.
fn is_fmt_string(text: &[u8], quote: usize) -> bool {
    if quote < 3 || &text[quote - 3..quote] != b"fmt" {
        return false;
    }
    // `myfmt"..."` is an ordinary identifier followed by an ordinary string, so
    // the character before the word must not be part of a longer one.
    quote == 3 || !is_ident_body(text[quote - 4])
}

/// The `}` closing a hole that opened at `from`, or `None` if it never closes.
///
/// A nested `{` raises the depth, so `{a{b}}` is one hole rather than a hole
/// that ends early at the inner brace.
fn find_hole_end(text: &[u8], from: usize, body_end: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = from;
    while i < body_end {
        match text[i] {
            b'{' => depth += 1,
            b'}' => {
                if depth == 0 {
                    return Some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Push an `fmt` literal, splitting its `{...}` holes out of the string text.
///
/// A hole is a `{` followed by an identifier start or a digit, closed by the
/// matching `}` before the end of the literal. Every branch of that rule is
/// measured against the compiler rather than reasoned about:
///
///     fmt"{name}"      -> the value
///     fmt"{p.p_name}"  -> the value
///     fmt"{1 + 2}"     -> 3
///     fmt"{}"          -> {}          nothing follows the brace, so no hole
///     fmt"{{name}}"    -> {{name}}    a brace does not open an expression
///     fmt"\{name}"     -> \{name}     escaped, so it cannot open one
///
/// The doubled-brace case is why the brace itself has to be excluded and not
/// merely the character after it. `{{name}}` reads as literal text, so painting
/// the inner `{name}` would promise an interpolation the compiler never
/// performs - the same lie as highlighting a plain string, one level down.
fn push_fmt_string(buf: &mut Vec<u32>, text: &[u8], start: usize, end: usize) {
    // The body sits between the quotes. An unterminated literal has no closing
    // quote - the scan stops at the newline - so then the body runs to `end`.
    let body_end = if end > start + 1 && text[end - 1] == b'"' {
        end - 1
    } else {
        end
    };

    let mut lit = start;
    let mut i = start + 1;
    while i < body_end {
        if text[i] == b'\\' {
            i += 2; // an escaped character cannot open a hole
            continue;
        }
        // A brace directly after another brace is text, not the start of a
        // hole - see the table above.
        if text[i] == b'{' && i + 1 < body_end && text[i - 1] != b'{' {
            let first = text[i + 1];
            if is_ident_start(first) || first.is_ascii_digit() {
                if let Some(close) = find_hole_end(text, i + 1, body_end) {
                    push_token(buf, lit, i - lit, T_STRING);
                    push_token(buf, i, close + 1 - i, T_INTERP);
                    i = close + 1;
                    lit = i;
                    continue;
                }
            }
        }
        i += 1;
    }

    // Whatever is left, including the closing quote.
    push_token(buf, lit, end - lit, T_STRING);
}

/// Tokenise the whole document. Returns the token count; the packed triples
/// `[start, len, kind]` live at `lex_ptr()`.
///
/// **`start` and `len` are UTF-16 code unit offsets, not byte offsets.** That is
/// the unit the interface needs, because the string it slices is a JavaScript
/// string. The lexer walks bytes, so the conversion happens once at the end, in
/// `Doc::rewrite_offsets_as_utf16` - see the note there for what going without it
/// looked like.
#[no_mangle]
pub extern "C" fn lex(h: u32) -> u32 {
    let d = match docs().get(h as usize) {
        Some(d) => d,
        None => return 0,
    };
    let bytes = d.text.as_bytes();
    let n = bytes.len();
    let buf = lexbuf();
    buf.clear();
    buf.reserve(n / 4);

    let mut i = 0usize;
    let mut plain_from = 0usize;

    while i < n {
        let b = bytes[i];

        // line comment
        if b == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            push_plain_span(buf, &mut plain_from, i);
            let start = i;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            push_token(buf, start, i - start, T_COMMENT);
            plain_from = i;
            continue;
        }

        // string
        if b == b'"' {
            push_plain_span(buf, &mut plain_from, i);
            let start = i;
            i += 1;
            while i < n {
                if bytes[i] == b'\\' {
                    i += 2;
                    continue;
                }
                if bytes[i] == b'"' {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\n' {
                    break;
                }
                i += 1;
            }
            let end = i.min(n);
            if is_fmt_string(bytes, start) {
                push_fmt_string(buf, bytes, start, end);
            } else {
                push_token(buf, start, end - start, T_STRING);
            }
            plain_from = i;
            continue;
        }

        // number
        if b.is_ascii_digit() {
            push_plain_span(buf, &mut plain_from, i);
            let start = i;
            while i < n && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'.' || bytes[i] == b'_') {
                i += 1;
            }
            push_token(buf, start, i - start, T_NUMBER);
            plain_from = i;
            continue;
        }

        // identifier / keyword / type / call
        if is_ident_start(b) {
            let start = i;
            while i < n && is_ident_body(bytes[i]) {
                i += 1;
            }
            let word = &d.text[start..i];
            let kind = if KEYWORDS.contains(&word) {
                T_KEYWORD
            } else if TYPES.contains(&word) {
                T_TYPE
            } else {
                let mut k = i;
                while k < n && (bytes[k] == b' ' || bytes[k] == b'\t') {
                    k += 1;
                }
                if k < n && bytes[k] == b'(' {
                    T_FUNCTION
                } else {
                    T_PLAIN
                }
            };
            push_plain_span(buf, &mut plain_from, start);
            push_token(buf, start, i - start, kind);
            plain_from = i;
            continue;
        }

        // punctuation
        if is_punct(b) {
            push_plain_span(buf, &mut plain_from, i);
            push_token(buf, i, 1, T_PUNCT);
            i += 1;
            plain_from = i;
            continue;
        }

        i += 1;
    }
    push_plain_span(buf, &mut plain_from, n);

    // The scan above is over bytes; the interface is not. Convert once.
    d.rewrite_offsets_as_utf16(buf.as_mut_slice());

    (buf.len() / 3) as u32
}

#[no_mangle]
pub extern "C" fn lex_ptr() -> u32 {
    lexbuf().as_ptr() as u32
}

/// Convenience for the browser: lex a string that is not a document.
#[no_mangle]
pub extern "C" fn lex_scratch(ptr: u32, len: u32) -> u32 {
    let s = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    let text = String::from_utf8_lossy(s).into_owned();
    let h = doc_new();
    doc_set(h, ptr, len);
    let count = lex(h);
    let _ = text;
    doc_free(h);
    count
}
