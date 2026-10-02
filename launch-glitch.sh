#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"

# Auto-bootstrap if Node.js not available (neither bundled nor system)
if [ ! -f "$DIR/data/node/bin/node" ] && [ ! -f "$DIR/data/node/node" ] && ! command -v node &>/dev/null; then
  echo "Bootstrapping Glitch (first-time setup - downloading Node.js)..."
  NODE_VER=$(curl -sL https://nodejs.org/dist/index.json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print([r['version'] for r in d if r['lts']][0])" 2>/dev/null || echo "v22.14.0")
  OS=$(uname | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
  mkdir -p "$DIR/data/downloads"
  if command -v curl &>/dev/null; then
    curl -fsL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$OS-$ARCH.tar.gz" -o "$DIR/data/downloads/node.tar.gz"
  elif command -v wget &>/dev/null; then
    wget -q "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$OS-$ARCH.tar.gz" -O "$DIR/data/downloads/node.tar.gz"
  fi
  if [ -f "$DIR/data/downloads/node.tar.gz" ]; then
    mkdir -p "$DIR/data/node"
    tar -xzf "$DIR/data/downloads/node.tar.gz" -C "$DIR/data/downloads/"
    cp -r "$DIR/data/downloads/node-$NODE_VER-$OS-$ARCH/"* "$DIR/data/node/"
    rm -rf "$DIR/data/downloads/node-$NODE_VER-$OS-$ARCH" "$DIR/data/downloads/node.tar.gz"
  fi
  if [ ! -f "$DIR/data/node/bin/node" ] && [ ! -f "$DIR/data/node/node" ]; then
    echo "Bootstrap failed - Node.js still missing. Please install Node.js manually."
    exit 1
  fi
fi

# Prefer bundled Node.js; fall back to system
if [ -f "$DIR/data/node/bin/node" ]; then
  NODE_CMD="$DIR/data/node/bin/node"
  export PATH="$DIR/data/node/bin:$PATH"
elif [ -f "$DIR/data/node/node" ]; then
  NODE_CMD="$DIR/data/node/node"
  export PATH="$DIR/data/node:$PATH"
elif command -v node &>/dev/null; then
  NODE_CMD="node"
else
  echo "Error: Node.js is required. Install from https://nodejs.org"
  exit 1
fi

LOG_FILE="$DIR/data/launch.log"
mkdir -p "$DIR/data"

# First launch: sync engine skills into .pi/skills (Windows gets this from
# bootstrap-pi.ps1 step 5/6; on macOS/Linux nothing else does it, so the TUI
# would start without its skills). Idempotent: skipped once .pi/skills exists,
# non-fatal on any failure.
if [ ! -d "$DIR/.pi/skills" ] && [ -f "$DIR/scripts/sync-skills.mjs" ]; then
  echo "Syncing engine skills to .pi/skills..."
  "$NODE_CMD" "$DIR/scripts/sync-skills.mjs" --pi || echo "  (skills sync failed - continuing; run: node scripts/sync-skills.mjs --pi)"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Glitch starting..." > "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Args: $*" >> "$LOG_FILE"

"$NODE_CMD" "$DIR/scripts/launch-unified.mjs" "$@"
NODE_EXIT=$?
if [ $NODE_EXIT -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Glitch exited with code $NODE_EXIT" >> "$LOG_FILE"
fi
exit $NODE_EXIT
