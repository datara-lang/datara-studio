#!/usr/bin/env bash
# env.sh - establishes a working Datara/Forgen toolchain environment on Windows.
#
# Why this exists:
#   forgen performs AOT linking by invoking the MSVC `link.exe`. On a Git-Bash
#   machine the GNU coreutils `link` (a hardlink utility) shadows it on PATH and
#   linking fails with "extra operand '/DEBUG:NONE'". Prepending the real MSVC
#   toolset bin directory fixes it.
#
# Usage:  source scripts/env.sh
#
# Verified on: Windows 11, forgen 1.3.0, MSVC 14.50.35717 (VS 18 BuildTools)

MSVC_ROOT="/c/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC/Tools/MSVC/14.50.35717"
KITS_ROOT="/c/Program Files (x86)/Windows Kits/10"
KITS_VER="10.0.26100.0"

if [ -d "$MSVC_ROOT" ]; then
  export PATH="$MSVC_ROOT/bin/Hostx64/x64:$PATH"
  export LIB="C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.50.35717\\lib\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\${KITS_VER}\\ucrt\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\${KITS_VER}\\um\\x64"
  export INCLUDE="C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.50.35717\\include;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\${KITS_VER}\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\${KITS_VER}\\shared;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\${KITS_VER}\\um"
  export RYAN_MSVC_READY=1
else
  echo "[env] MSVC toolset not found - AOT linking will fall back to forgen run (JIT)." >&2
  export RYAN_MSVC_READY=0
fi

export PATH="$HOME/.cargo/bin:$PATH"
export FORGEN_AUTO_INSTALL=1
