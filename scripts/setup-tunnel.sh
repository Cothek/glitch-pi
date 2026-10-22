#!/usr/bin/env bash
# setup-tunnel.sh - Bash port of scripts/setup-tunnel.ps1
#
# Sets up a Cloudflare Tunnel for Glitch AI.
#   --auto   Machine-specific auto-setup (idempotent). Writes
#            data/cloudflare-domain.txt and config/cloudflared-config.yml.
#            This is the mode server-mode.mjs depends on.
#   (no flag) Interactive setup: authenticate, create tunnel 'glitch-ai',
#            route DNS.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_DOMAIN="cothekdesigns.com"
CONFIG_DIR="$ROOT/config"
DATA_DIR="$ROOT/data"

# --- Locate cloudflared: prefer bundled, fall back to PATH ---
CF="$ROOT/cloudflared"
if [ ! -x "$CF" ]; then
  CF="$(command -v cloudflared 2>/dev/null || true)"
  if [ -z "$CF" ]; then
    echo "ERROR: cloudflared not found. Run bootstrap or download manually." >&2
    exit 1
  fi
fi

usage() {
  cat <<'EOF'
Usage: setup-tunnel.sh [--auto]

  --auto    Auto-setup: create/reuse a machine-specific tunnel and write
            data/cloudflare-domain.txt + config/cloudflared-config.yml.
  -h|--help Show this help.

Interactive mode (no --auto): authenticate with Cloudflare, create tunnel
'glitch-ai', and route DNS glitch.cothekdesigns.com.
EOF
}

# find_tunnel_uuid <name> - print the UUID of an existing tunnel by name,
# or nothing if it does not exist. Tolerates missing/failed list output.
find_tunnel_uuid() {
  local want="$1"
  local list flat ids names
  list="$("$CF" tunnel list --output json 2>/dev/null || true)"
  [ -z "$list" ] && return 0
  flat="$(printf '%s' "$list" | tr -d ' \t\n')"
  ids="$(printf '%s' "$flat" | grep -oE '"id":"[a-f0-9-]+"' | sed -E 's/"id":"([a-f0-9-]+)"/\1/' || true)"
  names="$(printf '%s' "$flat" | grep -oE '"name":"[^"]+"' | sed -E 's/"name":"([^"]+)"/\1/' || true)"
  paste <(printf '%s\n' "$ids") <(printf '%s\n' "$names") \
    | awk -v want="$want" '$2==want {print $1; exit}'
}

# write_config <uuid> <hostname> - write config/cloudflared-config.yml atomically.
write_config() {
  local uuid="$1"
  local hostname="$2"
  local tmp_file="$CONFIG_DIR/cloudflared-config.yml.tmp"
  local config_file="$CONFIG_DIR/cloudflared-config.yml"

  mkdir -p "$CONFIG_DIR"
  cat > "$tmp_file" <<EOF
# Cloudflare Tunnel Configuration
# Tunnel: $tunnel_name (created by Glitch AI auto-setup)
# Machine: $machine

tunnel: $uuid
ingress:
  # ORIGIN 4103, NOT 4100: 4100 is the dead OpenCode-era auth-proxy port.
  # The live stack is pi-web-ui :8787 behind auth-proxy :4103. Port 4100 here
  # is what served 502 Bad Gateway on glitch.cotekdesigns.com (PM-063/PM-065).
  - hostname: $hostname
    service: http://localhost:4103
  - service: http_status:404
EOF

  if ! grep -Eq 'tunnel:[[:space:]]+[a-f0-9-]{8,}' "$tmp_file"; then
    rm -f "$tmp_file"
    echo "  Config validation failed: missing or invalid tunnel UUID" >&2
    exit 1
  fi
  if ! grep -Eq 'hostname:[[:space:]]+[^[:space:]]+' "$tmp_file"; then
    rm -f "$tmp_file"
    echo "  Config validation failed: missing hostname" >&2
    exit 1
  fi
  mv -f "$tmp_file" "$config_file"
  echo "  Config written: $config_file"
}

# ============================================================
# AUTO MODE
# ============================================================
if [ "${1:-}" = "--auto" ]; then
  echo ""
  echo "Glitch AI - Auto Tunnel Setup"
  echo ""

  machine_raw="$(hostname 2>/dev/null || echo unknown)"
  machine="$(printf '%s' "$machine_raw" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')"
  [ -n "$machine" ] || machine="unknown"
  tunnel_name="glitch-ai-$machine"
  dns_hostname="glitch-$machine.$BASE_DOMAIN"

  echo "  Machine: $machine_raw"
  echo "  Tunnel: $tunnel_name"
  echo "  DNS: $dns_hostname"
  echo ""

  # Re-run safe: reuse existing tunnel if present
  existing_uuid="$(find_tunnel_uuid "$tunnel_name" || true)"
  if [ -n "$existing_uuid" ]; then
    echo "  Tunnel '$tunnel_name' already exists (re-using)"
    uuid="$existing_uuid"
  else
    echo "  Creating tunnel '$tunnel_name'..."
    if ! create_output="$("$CF" tunnel create "$tunnel_name" 2>&1)"; then
      echo "  Tunnel creation failed: $create_output" >&2
      exit 1
    fi
    echo "  Tunnel created"

    # Parse UUID from output: "Created tunnel <name> with id <uuid>"
    uuid="$(printf '%s\n' "$create_output" | grep -oE 'id [a-f0-9-]+' | head -n1 | sed -E 's/id //' || true)"
    if [ -z "$uuid" ]; then
      # Fallback: re-list to find UUID
      uuid="$(find_tunnel_uuid "$tunnel_name" || true)"
    fi
  fi

  if [ -z "$uuid" ]; then
    echo "  Failed to determine tunnel UUID" >&2
    exit 1
  fi

  echo "  Tunnel UUID: $uuid"

  # Route DNS (idempotent - safe to re-run)
  echo "  Routing DNS $dns_hostname..."
  "$CF" tunnel route dns "$tunnel_name" "$dns_hostname" >/dev/null 2>&1 || true
  echo "  DNS route set"

  # Ensure data directory exists
  mkdir -p "$DATA_DIR"

  # Write domain file (so server-mode.mjs can read it)
  printf '%s' "$dns_hostname" > "$DATA_DIR/cloudflare-domain.txt"

  # Write config file atomically
  write_config "$uuid" "$dns_hostname"

  echo ""
  echo "Auto-setup complete!"
  echo "  Tunnel: $tunnel_name (UUID: $uuid)"
  echo "  URL: https://$dns_hostname"
  echo ""
  exit 0
fi

# ============================================================
# HELP
# ============================================================
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

if [ $# -gt 0 ]; then
  echo "Unknown option: $1" >&2
  usage >&2
  exit 1
fi

# ============================================================
# INTERACTIVE MODE (original behavior)
# ============================================================
echo ""
echo "Glitch AI - Cloudflare Tunnel Setup"
echo ""

echo "Step 1: Authenticate with Cloudflare"
echo "  This opens a browser window. Log in with your Cloudflare account."
echo "  (Select $BASE_DOMAIN if prompted)"
echo ""
if ! "$CF" tunnel login; then
  echo "Authentication failed. Re-run this script." >&2
  exit 1
fi
echo "  Authenticated successfully"
echo ""

TUNNEL_NAME="glitch-ai"
HOSTNAME="glitch.$BASE_DOMAIN"

echo "Step 2: Create tunnel '$TUNNEL_NAME'"
if ! "$CF" tunnel create "$TUNNEL_NAME"; then
  echo "Tunnel creation failed. Tunnel may already exist." >&2
  echo "  To delete and recreate: cloudflared tunnel delete $TUNNEL_NAME" >&2
fi
echo ""

echo "Step 3: Route DNS"
echo "  Creating DNS record: $HOSTNAME -> tunnel"
if ! "$CF" tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"; then
  echo "DNS route may already exist (this is fine)" >&2
fi
echo ""

echo "Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Run launch-glitch.sh and select server mode to start the server + tunnel"
echo "  2. Visit https://$HOSTNAME"
echo ""