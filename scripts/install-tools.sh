#!/usr/bin/env bash
# Installs every tool pinned in tools.lock.json into .tools/ (no admin rights, nothing system-wide).
# Usage: bash scripts/install-tools.sh [tool ...]   (no args = all tools)
# Re-running is safe: a tool whose exe already exists is skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/tools.lock.json"
TOOLS="$ROOT/.tools"
DL="$TOOLS/_downloads"
mkdir -p "$DL"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  Linux) OS=linux ;;
  Darwin) OS=macos ;;
  *) OS=unknown ;;
esac
echo "install-tools: detected OS = $OS"
if [ "$OS" != "windows" ]; then
  echo "install-tools: tools.lock.json only pins windows-x64 builds so far. Add $OS entries before installing here." >&2
  exit 2
fi

# Read one field of one tool from the lock file.
field() { node -e "const l=require(process.argv[1]);const v=l.tools[process.argv[2]][process.argv[3]];process.stdout.write(v==null?'':String(v))" "$LOCK" "$1" "$2"; }
names() { node -e "process.stdout.write(Object.keys(require(process.argv[1]).tools).join(' '))" "$LOCK"; }
set_sha() { node -e "const fs=require('fs');const p=process.argv[1];const l=JSON.parse(fs.readFileSync(p,'utf8'));l.tools[process.argv[2]].sha256=process.argv[3];fs.writeFileSync(p,JSON.stringify(l,null,2)+'\n')" "$LOCK" "$1" "$2"; }

install_one() {
  local name="$1"
  local archive url sha dir exe file
  archive="$(field "$name" archive)"
  exe="$(field "$name" exe)"

  if [ "$archive" = "system" ]; then
    if command -v "$exe" >/dev/null 2>&1; then
      echo "[$name] present on PATH: $(command -v "$exe")"
    else
      echo "[$name] missing. Installing with winget (user scope, no admin)."
      winget install --id Gyan.FFmpeg -e --scope user --accept-package-agreements --accept-source-agreements
    fi
    return
  fi

  if [ -e "$TOOLS/$exe" ]; then
    echo "[$name] already installed: .tools/$exe"
    return
  fi

  url="$(field "$name" url)"
  sha="$(field "$name" sha256)"
  dir="$(field "$name" dir)"
  file="$DL/$(basename "${url%/download}")"

  if [ ! -s "$file" ]; then
    echo "[$name] downloading $url"
    # -C - resumes a partial .part file; retry the whole transfer a few times on dropped connections.
    local tries=0
    until curl -fL -C - --retry 3 --retry-delay 2 -o "$file.part" "$url"; do
      tries=$((tries + 1))
      if [ "$tries" -ge 5 ]; then echo "[$name] download failed after $tries attempts" >&2; exit 1; fi
      echo "[$name] transfer interrupted, resuming (attempt $((tries + 1)))"
      sleep 3
    done
    mv "$file.part" "$file"
  fi

  local got
  got="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ -z "$sha" ]; then
    echo "[$name] no published checksum; recording $got in tools.lock.json"
    set_sha "$name" "$got"
  elif [ "$got" != "$sha" ]; then
    echo "[$name] CHECKSUM MISMATCH: expected $sha got $got. Deleting download." >&2
    rm -f "$file"
    exit 1
  else
    echo "[$name] checksum ok"
  fi

  rm -rf "${TOOLS:?}/$dir"
  mkdir -p "$TOOLS/$dir"
  case "$archive" in
    zip)
      unzip -q "$file" -d "$TOOLS/$dir"
      ;;
    msi)
      # Administrative install = plain file extraction, no registry, no elevation.
      local target
      target="$(cygpath -w "$TOOLS/$dir")"
      MSYS_NO_PATHCONV=1 msiexec /a "$(cygpath -w "$file")" /qn TARGETDIR="$target"
      # msiexec returns before files settle on some systems; wait for the exe.
      for _ in $(seq 1 120); do [ -e "$TOOLS/$exe" ] && break; sleep 1; done
      ;;
    *) echo "[$name] unknown archive type $archive" >&2; exit 1 ;;
  esac

  # Some zips have no top-level folder; normalise so exe paths in the lock hold.
  if [ ! -e "$TOOLS/$exe" ]; then
    echo "[$name] installed, but expected exe not found at .tools/$exe. Contents:" >&2
    find "$TOOLS/$dir" -maxdepth 3 -iname "$(basename "$exe")" >&2
    exit 1
  fi
  echo "[$name] installed: .tools/$exe"
}

if [ "$#" -gt 0 ]; then list="$*"; else list="$(names)"; fi
for t in $list; do install_one "$t"; done
echo "install-tools: done. Next: npm run harness -- doctor"
