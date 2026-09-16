#!/usr/bin/env bash
# msvc-env.sh - put MSVC's linker first on PATH.
#
# Needed for anything that produces a native Windows binary from this
# repository: `cargo build` for the Tauri shell, and `forgen build` / `forgen
# test` for AOT output. Without it, Git-Bash's GNU `link` (at /usr/bin/link.exe)
# shadows MSVC's and linking fails with `extra operand '/DEBUG:NONE'`, which
# reads like a compiler bug and is not one.
#
# Source it, do not run it:
#
#     source scripts/msvc-env.sh
#     cargo build --release --manifest-path src-tauri/Cargo.toml
#
# The versions are discovered rather than hardcoded, because a BuildTools update
# changes the directory name and a hardcoded path then fails in a confusing way.

_msvc_env() {
  local vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  local root=""

  if [ -x "$vswhere" ]; then
    root="$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 \
            -property installationPath 2>/dev/null | tr -d '\r')"
  fi
  if [ -z "$root" ]; then
    # fall back to the usual locations
    for candidate in "/c/Program Files (x86)/Microsoft Visual Studio"/*/BuildTools \
                     "/c/Program Files/Microsoft Visual Studio"/*/*; do
      if [ -d "$candidate/VC/Tools/MSVC" ]; then root="$candidate"; break; fi
    done
  fi
  if [ -z "$root" ]; then
    echo "msvc-env: no Visual Studio installation found" >&2
    return 1
  fi

  # vswhere reports a Windows path; Git-Bash wants /c/... for its own tools but
  # INCLUDE and LIB must stay Windows-shaped, because link.exe reads them.
  local winroot="$root"
  local msvc_dir
  msvc_dir="$(ls -d "$(cygpath -u "$winroot" 2>/dev/null || echo "$winroot")"/VC/Tools/MSVC/* 2>/dev/null | sort -V | tail -1)"
  local msvc_ver
  msvc_ver="$(basename "$msvc_dir")"

  local sdk="/c/Program Files (x86)/Windows Kits/10"
  local sdk_ver
  # not `xargs basename`: the SDK path contains a space, and xargs would split it
  sdk_ver="$(ls -d "$sdk"/Include/* 2>/dev/null | sort -V | tail -1)"
  sdk_ver="${sdk_ver##*/}"

  local msvc_bin="$msvc_dir/bin/Hostx64/x64"
  if [ ! -d "$msvc_bin" ]; then
    echo "msvc-env: no x64 toolchain under $msvc_dir" >&2
    return 1
  fi

  export PATH="$msvc_bin:$PATH"
  export INCLUDE="$(cygpath -w "$msvc_dir/include" 2>/dev/null || echo "$msvc_dir/include");C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$sdk_ver\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$sdk_ver\\um;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\$sdk_ver\\shared"
  export LIB="$(cygpath -w "$msvc_dir/lib/x64" 2>/dev/null || echo "$msvc_dir/lib/x64");C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$sdk_ver\\ucrt\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\$sdk_ver\\um\\x64"

  echo "msvc-env: MSVC $msvc_ver, Windows SDK $sdk_ver"
  echo "msvc-env: link -> $(command -v link.exe)"
}

_msvc_env
