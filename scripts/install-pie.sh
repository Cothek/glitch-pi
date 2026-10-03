#!/usr/bin/env bash
# Glitch Pie Installer for macOS/Linux (POSIX-compatible)
# Standalone installer - download and run directly from GitHub.
#
# Usage:
#   curl -sL https://raw.githubusercontent.com/Cothek/glitch-pi/main/scripts/install-pie.sh | bash
#   wget -qO- https://raw.githubusercontent.com/Cothek/glitch-pi/main/scripts/install-pie.sh | bash
#   bash install.sh [install_dir] [--no-launch]
#   curl -sL https://raw.githubusercontent.com/Cothek/glitch-pi/develop/scripts/install-pie.sh -o /tmp/glitch-install.sh && bash /tmp/glitch-install.sh --branch develop

set -euo pipefail

# Default values
INSTALL_DIR="${1:-$HOME/glitch-pi}"
NO_LAUNCH=false
NO_SHORTCUT=false
USER_REPO=""
BRANCH=""

# Bump this whenever installer behavior changes -- printed at startup for issue identification
INSTALLER_VERSION="1.1.0-pie.1"

# Set up logging - captures all output to a file for diagnosis.
# Logs to /tmp first (the install dir may not exist yet and must not be
# created before the clone). After a successful clone the log is copied
# into $INSTALL_DIR/install.log at the end of the script.
LOG_FILE="/tmp/glitch-install.log"
setup_logging() {
    exec > >(tee -a "$LOG_FILE") 2>&1
    echo "=== Install started: $(date) -- installer v${INSTALLER_VERSION} ==="
}
setup_logging

_BRANCH_DISPLAY="${BRANCH:-(default main)}"
echo ""
echo "  Glitch Pie Installer v${INSTALLER_VERSION}"
echo "  Install dir : $INSTALL_DIR"
echo "  Branch      : $_BRANCH_DISPLAY"
echo "  Platform    : $(uname -s)"
echo ""

# Catch errors and show log location
trap 'echo ""; echo "  FATAL ERROR: Line $LINENO"; echo "  Log file: $LOG_FILE"; echo "  Please share this log file when reporting the issue."; exit 1' ERR

INSTALL_ISSUES=false

# Parse arguments
for arg in "$@"; do
    case "$arg" in
        --no-launch) NO_LAUNCH=true ;;
        --no-shortcut) NO_SHORTCUT=true ;;
        --user-repo) ;; # handled by next iteration
        --user-repo=*) USER_REPO="${arg#*=}" ;;
        --branch) ;; # handled by next iteration
        --branch=*) BRANCH="${arg#*=}" ;;
        --help|-h)
            cat <<'EOF'
Glitch Pie Installer for macOS/Linux

Usage:
  curl -sL https://raw.githubusercontent.com/Cothek/glitch-pi/main/scripts/install-pie.sh | bash [install_dir] [--no-launch] [--no-shortcut] [--user-repo <url>] [--branch <name>]
  wget -qO- https://raw.githubusercontent.com/Cothek/glitch-pi/main/scripts/install-pie.sh | bash [install_dir] [--no-launch] [--no-shortcut] [--user-repo <url>] [--branch <name>]

Arguments:
  install_dir              Custom install directory (default: $HOME/glitch-pi)
  --no-launch              Skip launch prompt after installation
  --no-shortcut            Skip desktop shortcut offer
  --user-repo <url>        GitHub user repo URL for profile sync (e.g. https://github.com/user/repo.git)
  --branch <name>          Checkout a specific repo branch after cloning (e.g. develop)
  --help, -h               Show this help

Prerequisites:
  - git
  - curl or wget
  - Internet connection

Node.js is NOT required - the launch scripts handle everything.
EOF
            exit 0
            ;;
        *)
            # Check if previous arg was --user-repo or --branch
            if [ "${PREV_ARG:-}" = "--user-repo" ]; then
                USER_REPO="$arg"
            elif [ "${PREV_ARG:-}" = "--branch" ]; then
                BRANCH="$arg"
            fi
            ;;
    esac
    PREV_ARG="$arg"
done

# Color codes (ANSI)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Output helpers
header() { printf "\n${MAGENTA}%s${NC}\n" "$1"; }
step()   { printf "  ${CYAN}%s${NC}\n" "$1"; }
success(){ printf "  ${GREEN}%s${NC}\n" "$1"; }
warn()   { printf "  ${YELLOW}%s${NC}\n" "$1"; }
error()  { printf "  ${RED}%s${NC}\n" "$1" >&2; }
prompt() { printf "  ${CYAN}%s${NC}" "$1"; }

# ── Spinner helper for long operations ──
# Shows a rotating spinner + elapsed seconds while running a command.
# Captures stdout+stderr to a temp file shown on failure.
# Usage: spinner "Label" command arg1 arg2 ...
# Exit code: returns the command's exit code (caller should handle errors)
spinner() {
  local label="$1"
  shift
  local chars='-\|/'
  local i=0
  local start_time
  local tmp_out
  tmp_out=$(mktemp 2>/dev/null || mktemp -t glitch-spinner 2>/dev/null || echo "/tmp/glitch-spinner-$$")
  
  start_time=$(date +%s 2>/dev/null || python3 -c 'import time; print(int(time.time()))' 2>/dev/null || echo "0")
  
  # Run command, capture stdout+stderr to temp file
  "$@" >"$tmp_out" 2>&1 &
  local pid=$!
  
  while kill -0 "$pid" 2>/dev/null; do
    local now
    now=$(date +%s 2>/dev/null || python3 -c 'import time; print(int(time.time()))' 2>/dev/null || echo "0")
    local elapsed=$((now - start_time))
    printf "\r  %s %c (%ds)" "$label" "${chars:$i%4:1}" "$elapsed" 2>/dev/null || true
    i=$((i+1))
    sleep 0.2 2>/dev/null || sleep 1
  done
  
  # Wait and capture exit code (|| assignment keeps set -e from exiting;
  # the old `wait ... || true` always left $? at 0, so failures looked like success)
  local exit_code=0
  wait "$pid" 2>/dev/null || exit_code=$?
  
  # Clear spinner line
  printf "\r                                                  \r" 2>/dev/null || true
  
  # On failure, show captured output
  if [ $exit_code -ne 0 ] && [ -s "$tmp_out" ]; then
    while IFS= read -r line; do
      printf "    %s\n" "$line" >&2
    done < "$tmp_out"
  fi
  
  rm -f "$tmp_out" 2>/dev/null || true
  return $exit_code
}

# ── Desktop shortcut offer ──
# Creates a double-clickable launcher on the user's Desktop.
# macOS: ~/Desktop/Glitch.command (Terminal launcher, chmod +x)
# Linux: ~/Desktop/glitch.desktop (XDG launcher, chmod +x)
# Wrapped so a shortcut failure NEVER fails the install — warns and continues.
offer_desktop_shortcut() {
    local launcher="$INSTALL_DIR/launch-glitch.sh"
    if [ ! -x "$launcher" ] && [ ! -f "$launcher" ]; then
        warn "Skipping desktop shortcut: launcher not found at $launcher"
        return 0
    fi

    local os
    os="$(uname -s 2>/dev/null || echo unknown)"

    if [ "$os" = "Darwin" ]; then
        # macOS — ~/Desktop/Glitch.command (Terminal launcher)
        local desktop_dir="$HOME/Desktop"
        if [ ! -d "$desktop_dir" ]; then
            warn "Skipping desktop shortcut: $desktop_dir does not exist."
            return 0
        fi
        local shortcut="$desktop_dir/Glitch.command"
        prompt "Create a desktop shortcut to launch Glitch? (Y/n): "
        local answer=""
        read -r answer </dev/tty || answer=""
        if [ -z "$answer" ] || [[ "$answer" =~ ^[Yy] ]]; then
            if {
                printf '#!/usr/bin/env bash\n'
                printf '# Launch Glitch Pie — double-click to start.\n'
                printf 'cd %q || exit 1\n' "$INSTALL_DIR"
                printf 'exec %q "$@"\n' "$launcher"
            } > "$shortcut" && chmod +x "$shortcut"; then
                success "Desktop shortcut created: $shortcut"
            else
                warn "Could not create desktop shortcut at $shortcut"
            fi
        else
            step "Skipped desktop shortcut."
        fi
    else
        # Linux (and other Unix) — XDG .desktop file
        local desktop_dir
        desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
        if [ -z "$desktop_dir" ] || [ ! -d "$desktop_dir" ]; then
            desktop_dir="$HOME/Desktop"
        fi
        if [ ! -d "$desktop_dir" ]; then
            warn "Skipping desktop shortcut: $desktop_dir does not exist."
            return 0
        fi
        local shortcut="$desktop_dir/glitch.desktop"
        prompt "Create a desktop shortcut to launch Glitch? (Y/n): "
        local answer=""
        read -r answer </dev/tty || answer=""
        if [ -z "$answer" ] || [[ "$answer" =~ ^[Yy] ]]; then
            if {
                printf '[Desktop Entry]\n'
                printf 'Type=Application\n'
                printf 'Name=Glitch\n'
                printf 'Comment=Launch Glitch Pie\n'
                printf 'Exec=%q\n' "$launcher"
                printf 'Terminal=true\n'
                printf 'Categories=Development;\n'
                printf 'Icon=%s\n' "$INSTALL_DIR/assets/glitch-icon.png"
            } > "$shortcut" && chmod +x "$shortcut"; then
                success "Desktop shortcut created: $shortcut"
            else
                warn "Could not create desktop shortcut at $shortcut"
            fi
        else
            step "Skipped desktop shortcut."
        fi
    fi
}

# Resolve the last commit that touched this installer on the selected branch (best-effort, for issue identification)
INSTALLER_COMMIT=""
if command -v curl >/dev/null 2>&1; then
  COMMIT_API_JSON=$(curl -s --max-time 10 "https://api.github.com/repos/Cothek/glitch-pi/commits?path=scripts/install-pie.sh&sha=${BRANCH:-main}" 2>/dev/null || true)
  if [ -n "$COMMIT_API_JSON" ]; then
    if command -v jq >/dev/null 2>&1; then
      INSTALLER_COMMIT=$(printf '%s' "$COMMIT_API_JSON" | jq -r '.[0].sha // empty' 2>/dev/null | head -c 7)
    else
      INSTALLER_COMMIT=$(printf '%s' "$COMMIT_API_JSON" | grep -o '"sha": *"[a-f0-9]\{40\}"' | head -n 1 | sed -n 's/.*"\([a-f0-9]\{7\}\)[a-f0-9]*".*/\1/p')
    fi
  fi
fi

# Banner
if [ -n "$INSTALLER_COMMIT" ]; then
  BANNER_VERSION_CONTENT="v${INSTALLER_VERSION} - commit ${INSTALLER_COMMIT} (${BRANCH:-main})"
else
  BANNER_VERSION_CONTENT="v${INSTALLER_VERSION}"
fi
BANNER_PAD=$(( (77 - ${#BANNER_VERSION_CONTENT}) / 2 ))
if [ "$BANNER_PAD" -lt 0 ]; then BANNER_PAD=0; fi
BANNER_VERSION_LINE="║$(printf '%*s' "$BANNER_PAD" '')${BANNER_VERSION_CONTENT}$(printf '%*s' $((77 - BANNER_PAD - ${#BANNER_VERSION_CONTENT})) '')║"
# Center every banner line at the same 77-char inner width as the borders.
# The hand-counted literal lines used to render at four different widths
# (81/81/80/80/79), so the right ║ never lined up with the border corners.
banner_line() {
    local text="$1"
    local pad=$(( (77 - ${#text}) / 2 ))
    if [ "$pad" -lt 0 ]; then pad=0; fi
    local right=$((77 - pad - ${#text}))
    if [ "$right" -lt 0 ]; then right=0; fi
    printf '║%*s%s%*s║' "$pad" '' "$text" "$right" ''
}
cat <<EOF
╔$(printf '═%.0s' {1..77})╗
$(banner_line "GLITCH PIE INSTALLER (macOS/Linux)")
$(banner_line "Personal AI Companion - Persistent Memory")
$BANNER_VERSION_LINE
╚$(printf '═%.0s' {1..77})╝
EOF

# 1. Check prerequisites
header "Checking prerequisites..."

# Check git — auto-install via package manager if missing
if ! command -v git >/dev/null 2>&1; then
    warn "Git not found in PATH."

    # macOS — Homebrew
    if command -v brew >/dev/null 2>&1; then
        prompt "Install git via Homebrew? (Y/n): "
        read -r answer </dev/tty
        if [ -z "$answer" ] || echo "$answer" | grep -qi "^y"; then
            step "Installing git via Homebrew..."
            brew install git
            success "Git installed: $(command -v git)"
        else
            error "Install git manually: brew install git"
            exit 1
        fi

    # Debian/Ubuntu — apt
    elif command -v apt-get >/dev/null 2>&1; then
        prompt "Install git via apt (requires sudo)? (Y/n): "
        read -r answer </dev/tty
        if [ -z "$answer" ] || echo "$answer" | grep -qi "^y"; then
            step "Installing git via apt..."
            sudo apt-get install -y git
            success "Git installed: $(command -v git)"
        else
            error "Install git manually: sudo apt-get install git"
            exit 1
        fi

    # Fedora/RHEL — dnf
    elif command -v dnf >/dev/null 2>&1; then
        prompt "Install git via dnf (requires sudo)? (Y/n): "
        read -r answer </dev/tty
        if [ -z "$answer" ] || echo "$answer" | grep -qi "^y"; then
            step "Installing git via dnf..."
            sudo dnf install -y git
            success "Git installed: $(command -v git)"
        else
            error "Install git manually: sudo dnf install git"
            exit 1
        fi

    # Alpine — apk
    elif command -v apk >/dev/null 2>&1; then
        prompt "Install git via apk (requires sudo)? (Y/n): "
        read -r answer </dev/tty
        if [ -z "$answer" ] || echo "$answer" | grep -qi "^y"; then
            step "Installing git via apk..."
            sudo apk add git
            success "Git installed: $(command -v git)"
        else
            error "Install git manually: sudo apk add git"
            exit 1
        fi

    # Unknown package manager
    else
        error "No known package manager found."
        error "Install git manually, then re-run this script."
        error "  macOS: brew install git"
        error "  Debian/Ubuntu: sudo apt-get install git"
        error "  Fedora: sudo dnf install git"
        error "  Alpine: sudo apk add git"
        exit 1
    fi

    # Verify git is now available
    if ! command -v git >/dev/null 2>&1; then
        error "Git installation failed."
        error "Install git manually, then re-run this script."
        exit 1
    fi
fi
success "Git found: $(command -v git)"

# Check curl or wget
if command -v curl >/dev/null 2>&1; then
    FETCH_CMD="curl -sL"
elif command -v wget >/dev/null 2>&1; then
    FETCH_CMD="wget -qO-"
else
    error "Neither curl nor wget found. Install one of them."
    exit 1
fi
success "Fetch tool: $FETCH_CMD"

# 2. Choose install location
header "Installation location"

# Only prompt if INSTALL_DIR is the default (not explicitly passed)
if [ "$INSTALL_DIR" = "$HOME/glitch-pi" ]; then
    echo ""
    echo "  [1] Current directory: $(pwd)/glitch-pi"
    echo "  [2] User home directory: $HOME/glitch-pi (default)"
    echo "  [3] Custom path"
    echo ""
    prompt "  Choose (Enter=2): "
    read -r loc_choice </dev/tty
    case "$loc_choice" in
        1) INSTALL_DIR="$(pwd)/glitch-pi" ;;
        3)
            prompt "  Enter installation path: "
            read -r custom_dir </dev/tty
            if [ -n "$custom_dir" ]; then
                INSTALL_DIR="$custom_dir"
            fi
            ;;
    esac
fi
success "Installation directory: $INSTALL_DIR"

# 3. Check install directory
header "Installation directory: $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
    # Existing git repo — offer update
    warn "Glitch Pie already installed at $INSTALL_DIR"
    prompt "Update to latest version? (Y/n): "
    read -r update </dev/tty
    if [ -z "$update" ] || [[ "$update" =~ ^[Yy] ]]; then
        step "Pulling latest changes..."
        (cd "$INSTALL_DIR" && git pull --ff-only)
        if [ $? -eq 0 ]; then
            success "Updated to latest version"
        else
            error "Update failed. You may have local changes."
            warn "Try: cd $INSTALL_DIR && git status"
            exit 1
        fi
    else
        warn "Skipping update. Using existing installation."
    fi
elif [ -d "$INSTALL_DIR" ]; then
    # Directory exists but not a git repo — ask what to do
    warn "Directory '$INSTALL_DIR' already exists (not a git repo)."
    echo ""
    echo "  [1] Overwrite (delete and re-clone)"
    echo "  [2] Choose a different directory"
    echo "  [3] Cancel"
    echo ""
    prompt "  Choose (Enter=3): "
    read -r over_choice </dev/tty
    case "$over_choice" in
        1)
            step "Removing existing directory..."
            rm -rf "$INSTALL_DIR"
            success "Directory cleared."
            ;;
        2)
            prompt "  Enter new installation path: "
            read -r new_dir </dev/tty
            if [ -n "$new_dir" ]; then
                INSTALL_DIR="$new_dir"
                success "Will install to: $INSTALL_DIR"
            else
                warn "Installation cancelled."
                exit 0
            fi
            ;;
        *)
            warn "Installation cancelled."
            exit 0
            ;;
    esac
fi

# Fresh clone (if not a git repo already)
if [ ! -d "$INSTALL_DIR/.git" ]; then
    parent_dir="$(dirname "$INSTALL_DIR")"
    mkdir -p "$parent_dir" 2>/dev/null || true
    
    # Two-step clone: repo first, submodules individually so one failure doesn't kill install
    if spinner "Cloning Glitch Pie repository" git clone https://github.com/Cothek/glitch-pi.git "$INSTALL_DIR"; then
        success "Repository cloned to $INSTALL_DIR"
    else
        error "Clone failed"
        exit 1
    fi
    
    # Initialize submodules individually - failures are logged, not fatal
    ISSUE_FILE="$INSTALL_DIR/data/install-issues.md"
    mkdir -p "$INSTALL_DIR/data"
    
    cd "$INSTALL_DIR" || exit 1

    # Optional branch checkout (mirrors install.ps1 -Branch behavior)
    if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ]; then
        step "Checking out branch: $BRANCH..."
        if ! checkout_err=$(git checkout "$BRANCH" 2>&1); then
            warn "Could not checkout branch: $BRANCH (continuing on default branch)"
            echo "    $checkout_err" >&2
        fi
    fi

    echo ""
    step "Initializing submodules..."
    
    # Init submodule registry (non-fatal)
    git submodule init 2>&1 | sed 's/^/    /' || true
    
    # Track each submodule's status
    SUBMODULE_OK=()
    SUBMODULE_FAILED=()
    
    # Read submodule list from .gitmodules (authoritative source)
    submodules=()
    while IFS= read -r line; do
        submodules+=("$line")
    done < <(git config --file .gitmodules --get-regexp path | awk '{print $2}')

    if [ ${#submodules[@]} -eq 0 ]; then
        warn "No submodules found in .gitmodules"
    else
        for submodule in "${submodules[@]}"; do
            echo ""
            step "Updating submodule: $submodule"
            # Use if/then so set -e doesn't kill the script on a single submodule failure
            if git submodule update --init "$submodule" > /tmp/glitch-sub-err.tmp 2>&1; then
                success "  $submodule: OK"
                SUBMODULE_OK+=("$submodule")
            else
                SUBMODULE_EXIT=$?
                SUBMODULE_OUTPUT=$(cat /tmp/glitch-sub-err.tmp)
                warn "  $submodule: FAILED"
                echo "$SUBMODULE_OUTPUT" | sed 's/^/    /'
                SUBMODULE_FAILED+=("$submodule")
                INSTALL_ISSUES=true

                # Log to install-issues.md
                {
                    echo ""
                    echo "## Install Issue - $(date '+%Y-%m-%d %H:%M:%S')"
                    echo "- **Subsystem**: Submodule clone"
                    echo "- **Component**: $submodule"
                    echo "- **Error**:"
                    echo '```'
                    echo "$SUBMODULE_OUTPUT"
                    echo '```'
                    echo "- **Impact**: Some memory/skill files may be missing until resolved"
                    echo "- **Fix**: Tell Glitch \"check install issues\" or run: cd $INSTALL_DIR && git submodule update --init --recursive"
                    echo ""
                } >> "$ISSUE_FILE"
            fi
            rm -f /tmp/glitch-sub-err.tmp
        done
    fi
    
    echo ""
    if [ "$INSTALL_ISSUES" = false ]; then
        success "All submodules initialized successfully"
    else
        warn "Some submodules failed to clone (see above)"
        warn "Issues logged to: $ISSUE_FILE"
        warn "Glitch will attempt to fix these on first launch."
    fi
fi

# 4. Bootstrap check (Windows has bootstrap-pi.ps1; on macOS/Linux the launch
#    scripts self-provision: Node.js via launch-glitch.sh, the Pi engine via
#    the first-run dependency installer inside launch-unified.mjs)
header "Checking for bootstrap script..."
BOOTSTRAP_PATH="$INSTALL_DIR/scripts/bootstrap-pi.ps1"
if [ -f "$BOOTSTRAP_PATH" ]; then
    step "bootstrap-pi.ps1 present (used by Windows installs; not run here)."
    step "On macOS/Linux, launch-glitch.sh downloads Node.js and the first"
    step "interactive launch installs the Pi engine (pi CLI + pi-web-ui)."
else
    warn "bootstrap-pi.ps1 not found — launch-glitch.sh will still fetch Node.js."
fi


# 4.5. Install GitNexus (MCP code graph)
header "Installing GitNexus (MCP code graph)..."
GITNEXUS_OK=0
BUNDLED_NODE_BIN="$INSTALL_DIR/data/node/bin"
BUNDLED_NPM="$BUNDLED_NODE_BIN/npm"

# Skip if gitnexus is already present (bundled tree or PATH)
ALREADY_INSTALLED=0
if [ -d "$INSTALL_DIR/data/node/lib/node_modules/gitnexus" ] || \
   [ -x "$BUNDLED_NODE_BIN/gitnexus" ] || \
   command -v gitnexus >/dev/null 2>&1; then
  ALREADY_INSTALLED=1
fi

if [ "$ALREADY_INSTALLED" -eq 1 ]; then
  GITNEXUS_OK=1
  success "GitNexus already installed (MCP code graph)"
else
  # Prefer bundled npm (always writable, correct Node version); fall back to system npm
  NPM_CMD=""
  if [ -x "$BUNDLED_NPM" ]; then
    NPM_CMD="$BUNDLED_NPM"
  elif command -v npm >/dev/null 2>&1; then
    NPM_CMD="npm"
  fi

  if [ -n "$NPM_CMD" ]; then
    # Prepend bundled node bin to PATH so postinstall scripts and bare node/npx
    # resolve the bundled node (gitnexus requires node >=22)
    export PATH="$BUNDLED_NODE_BIN:$PATH"

    step "Installing gitnexus via npm (MCP code graph)..."
    if NPM_OUTPUT=$("$NPM_CMD" install -g gitnexus 2>&1); then
      GITNEXUS_OK=1
    else
      warn "gitnexus npm install failed. Output:"
      printf '%s\n' "$NPM_OUTPUT" | sed 's/^/  /'
    fi

    # Verify after install
    if [ "$GITNEXUS_OK" -ne 1 ]; then
      if [ -x "$BUNDLED_NODE_BIN/gitnexus" ] || \
         [ -d "$INSTALL_DIR/data/node/lib/node_modules/gitnexus" ]; then
        GITNEXUS_OK=1
      else
        if "$NPM_CMD" list -g --depth=0 gitnexus 2>/dev/null | grep -q 'gitnexus@'; then
          GITNEXUS_OK=1
        fi
      fi
    fi
  else
    warn "No npm found (bundled or system). Cannot install GitNexus."
  fi
fi

if [ "$GITNEXUS_OK" -eq 1 ]; then
  success "GitNexus installed (MCP code graph)"
else
  warn "GitNexus install failed (non-fatal). Manual install: cd $INSTALL_DIR && ./data/node/bin/npm install -g gitnexus"
fi

# 4.7. Page-picker browser extension (pi-web-ui companion)
# Downloads the official pi-web-ui page-picker Chrome/Edge extension from GitHub
# releases and extracts it into $INSTALL_DIR/browser-extension/page-picker/ so it
# can be loaded unpacked straight from the installed Glitch folder.
# Non-fatal: a failure warns and prints the manual download URL.
header "Installing page-picker browser extension..."
PAGE_PICKER_URL="https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip"
PAGE_PICKER_DIR="$INSTALL_DIR/browser-extension/page-picker"
PAGE_PICKER_OK=0
if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
  STAGING_DIR="$(mktemp -d)/page-picker"
  mkdir -p "$STAGING_DIR"
  EXT_ZIP="$(mktemp).page-picker-extension.zip"
  if command -v curl >/dev/null 2>&1; then
    step "Downloading page-picker-extension.zip..."
    spinner "Downloading page-picker" curl -sL --fail --max-time 120 -o "$EXT_ZIP" "$PAGE_PICKER_URL"
    DL_EXIT=$?
  else
    step "Downloading page-picker-extension.zip (wget)..."
    spinner "Downloading page-picker" wget -q --timeout=120 -O "$EXT_ZIP" "$PAGE_PICKER_URL"
    DL_EXIT=$?
  fi
  if [ "$DL_EXIT" -eq 0 ]; then
    # Extract: unzip (macOS/Linux standard) -> bsdtar/GNU tar (macOS bsdtar reads
    # zips) -> python3 zipfile. Git Bash ships no unzip, tar keeps it working there.
    EX_EXIT=1
    if command -v unzip >/dev/null 2>&1; then
      spinner "Extracting page-picker" unzip -q -o "$EXT_ZIP" -d "$STAGING_DIR"
      EX_EXIT=$?
    elif command -v python3 >/dev/null 2>&1; then
      step "unzip not found - extracting with python3..."
      spinner "Extracting page-picker" python3 - "$EXT_ZIP" "$STAGING_DIR" <<'PYEOF'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    z.extractall(sys.argv[2])
PYEOF
      EX_EXIT=$?
    elif tar -tf "$EXT_ZIP" >/dev/null 2>&1; then
      step "unzip not found - extracting with tar..."
      spinner "Extracting page-picker" tar -xf "$EXT_ZIP" -C "$STAGING_DIR"
      EX_EXIT=$?
    else
      warn "No unzip, python3 or zip-capable tar found - cannot extract."
    fi
    # manifest.json must sit at the extension root for "Load unpacked";
    # tolerate a future nested layout
    if [ ! -f "$STAGING_DIR/manifest.json" ]; then
      NESTED="$(find "$STAGING_DIR" -mindepth 2 -maxdepth 2 -name manifest.json -print -quit 2>/dev/null)"
      if [ -n "$NESTED" ]; then
        step "Zip layout changed (nested folder) - using $(basename "$(dirname "$NESTED")")"
        STAGING_DIR="$(dirname "$NESTED")"
      fi
    fi
    if [ -f "$STAGING_DIR/manifest.json" ]; then
      rm -rf "$PAGE_PICKER_DIR"
      mkdir -p "$(dirname "$PAGE_PICKER_DIR")"
      mv "$STAGING_DIR" "$PAGE_PICKER_DIR"
      PAGE_PICKER_OK=1
      success "Page-picker extension installed at $PAGE_PICKER_DIR"
    else
      warn "Downloaded zip has no manifest.json (unexpected layout)"
    fi
  fi
  rm -f "$EXT_ZIP"
else
  warn "Neither curl nor wget found - cannot download page-picker extension."
fi
if [ "$PAGE_PICKER_OK" -ne 1 ]; then
  warn "Page-picker extension install failed (non-fatal)."
  if [ -f "$PAGE_PICKER_DIR/manifest.json" ]; then
    printf "  ${GRAY}Keeping existing copy at $PAGE_PICKER_DIR${NC}\n"
  else
    printf "  ${GRAY}Manual download: $PAGE_PICKER_URL${NC}\n"
    printf "  ${GRAY}Unzip to: $PAGE_PICKER_DIR${NC}\n"
  fi
else
  printf "\n  ${CYAN}Load it in your browser (one time):${NC}\n"
  printf "    1. Open chrome://extensions  (edge://extensions on Edge)\n"
  printf "    2. Enable Developer mode\n"
  printf "    3. Click 'Load unpacked' and select:\n"
  printf "    ${YELLOW}%s${NC}\n" "$PAGE_PICKER_DIR"
  printf "    4. Open the extension's options and set your pi-web-ui address:\n"
  printf "    ${YELLOW}http://localhost:8787${NC}  (default; click 'Authorize this address' if remote/LAN)\n"
fi

# 4.8. Desktop Control (cua-driver) - the AI's eyes and hands on this machine
# Optional install, user decision. Runs the official sudo-free installer from cua.ai
# (user-space, no admin) and wires the MCP server into the pi config so the desktop
# tools (screenshots, mouse, keyboard, window management) appear in pi directly.
header "Desktop Control (cua-driver)"

CUA_BIN="$HOME/.local/bin/cua-driver"
cua_present=0
if [ -x "$CUA_BIN" ] || command -v cua-driver >/dev/null 2>&1; then
  cua_present=1
  success "cua-driver already installed (desktop control MCP)"
fi

if [ "$cua_present" -eq 0 ]; then
  printf "  Desktop control gives the AI eyes and hands on this machine:\n"
  printf "    screenshots, mouse, keyboard, window management (via the cua-driver MCP server).\n"
  printf "  Official installer from cua.ai: user-space, sudo-free. Tools only run when the AI\n"
  printf "    calls them. Telemetry: pseudonymous ID only ('cua-driver telemetry disable' to opt out).\n"
  printf "  Install desktop control now? [y/N] "
  cua_answer=""
  read -r cua_answer </dev/tty || cua_answer=""
  if printf '%s' "$cua_answer" | grep -qi '^y'; then
    step "Installing cua-driver (official installer)..."
    CUA_OUT=""
    if CUA_OUT=$("$FETCH_CMD" -fsSL https://cua.ai/driver/install.sh | /bin/bash 2>&1); then
      cua_present=1
    else
      warn "cua-driver installer failed. Output:"
      printf '%s\n' "$CUA_OUT" | sed 's/^/  /'
      printf "  Manual install: /bin/bash -c \"\$(curl -fsSL https://cua.ai/driver/install.sh)\"\n"
    fi
    # The installer's own success is not the only signal: verify the binary.
    if [ "$cua_present" -eq 0 ] && [ -x "$CUA_BIN" ]; then
      cua_present=1
    fi
    if [ "$cua_present" -eq 1 ]; then
      success "cua-driver installed (desktop control MCP)"
    else
      warn "cua-driver install could not be verified (non-fatal)."
    fi
  else
    warn "Skipped. Add later with: /bin/bash -c \"\$(curl -fsSL https://cua.ai/driver/install.sh)\""
  fi
fi

# Wire the MCP server whenever the driver is present (also on re-install: keeps the
# wiring in sync). The ~/.local/bin wrapper path is stable across driver upgrades.
if [ -x "$CUA_BIN" ] || command -v cua-driver >/dev/null 2>&1; then
  WIRE_MCP="$(dirname "$0")/lib/wire-mcp.mjs"
  NODE_CMD=""
  if [ -x "$BUNDLED_NODE_BIN/node" ]; then
    NODE_CMD="$BUNDLED_NODE_BIN/node"
  elif command -v node >/dev/null 2>&1; then
    NODE_CMD="$(command -v node)"
  fi
  if [ -n "$NODE_CMD" ] && [ -f "$WIRE_MCP" ]; then
    # Resolve the real binary path for the MCP entry (PATH wins if set).
    CUA_RESOLVED="$(command -v cua-driver 2>/dev/null || echo "$CUA_BIN")"
    "$NODE_CMD" "$WIRE_MCP" --id cua-driver --command "$CUA_RESOLVED" --args mcp
  else
    warn "Could not wire the cua-driver MCP server (no node or helper missing)."
  fi
fi

# 4.9. Headless display - desktop capture stays alive with no monitor attached.
# Windows: handled by install.ps1 (Parsec Virtual Display Driver + one UAC prompt;
# under RDP the session must also run scripts/attach-session-to-console.ps1 once
# per login for desktop-wide capture - verified 2026-09-30).
# Linux (native or WSL2, which is where this script usually runs): informational
# only - capture needs an X11/Wayland session; on truly headless Linux run cua-driver
# behind Xvfb. No prompt here to keep the Windows contract (2 questions + 1 UAC).
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && ! grep -qi microsoft /proc/version 2>/dev/null; then
  warn "No display detected (headless Linux). Desktop capture needs Xvfb:"
  printf "    sudo apt install xvfb && xvfb-run cua-driver serve\n"
fi

# 5. User profile setup
header "User Profile Setup"
cat <<'EOF'
Glitch Pie stores your personal memory, preferences, and projects in a separate directory.
This lets your AI companion remember you across sessions.
EOF

# Ensure a local user profile exists so Glitch has memory from the start (never clobber an existing profile)
USER_DIR="$INSTALL_DIR/user"
mkdir -p "$USER_DIR"

# Create starter files for the profile (only if none exists yet — never clobber an existing profile)
if [ ! -f "$USER_DIR/main-memory.md" ]; then
  step "Creating local user profile..."

  cat > "$USER_DIR/main-memory.md" << 'PROFILEEOF'
---
type: UserProfile
title: Main Memory
description: Your personal profile and preferences
tags: [user, profile]
timestamp: 
---

# Main Memory

## User Profile
*To be filled in through interaction with Glitch*
PROFILEEOF

  cat > "$USER_DIR/current-session.md" << 'SESSIONEOF'
---
type: SessionMemory
title: Current Session Memory
tags: [session, ram]
timestamp: 
---

# Current Session Memory

## Session Recap
*First session with Glitch*
SESSIONEOF

  cat > "$USER_DIR/reminders.md" << 'REMINDERSEOF'
---
type: ReminderLog
title: Reminders
description: Cross-session reminders
tags: [reminders]
timestamp: 
---

# Reminders
REMINDERSEOF

  cat > "$USER_DIR/session-dashboard.md" << 'DASHEOF'
---
type: Dashboard
title: Session Dashboard
description: Active workstream tracker
tags: [dashboard]
timestamp: 
---

# Session Dashboard
DASHEOF

  # Fill empty timestamp fields in the 4 starter files with the current UTC time.
  # Heredocs are single-quoted (no shell expansion), so we patch them after writing.
  # sed -i.bak works on both GNU sed (Linux) and BSD sed (macOS); .bak is removed after.
  _TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  for _f in "$USER_DIR/main-memory.md" "$USER_DIR/current-session.md" "$USER_DIR/reminders.md" "$USER_DIR/session-dashboard.md"; do
    sed -i.bak "s|^timestamp: *$|timestamp: $_TS|" "$_f" && rm -f "$_f.bak"
  done

  success "Local user profile created at $USER_DIR"

  # Initialize the profile as a git repo on 'main' (never 'master'), the same
  # thing the Windows installer does. The completion message tells users to
  # `git add -A && git commit && git push` from user/ for cross-machine sync;
  # without a repo that push fails on macOS/Linux.
  if [ ! -d "$USER_DIR/.git" ]; then
    if git -C "$USER_DIR" init -b main >/dev/null 2>&1 || { git -C "$USER_DIR" init >/dev/null 2>&1 && git -C "$USER_DIR" branch -m main >/dev/null 2>&1; }; then
      success "  User profile git repo initialized on main"
    else
      warn "  Could not initialize git in the user profile (non-fatal)."
    fi
  fi
else
  success "User profile already exists at $USER_DIR (kept as-is)"
fi

# Optional: sync with GitHub for cross-machine access
SHOULD_SYNC=false
GH_USER=""
REPO_NAME=""

if [ -n "$USER_REPO" ]; then
    # Parse URL: https://github.com/user/repo.git or user/repo
    PARSED=$(echo "$USER_REPO" | sed 's|https\?://github\.com/||' | sed 's|\.git$||')
    GH_USER=$(echo "$PARSED" | cut -d'/' -f1)
    REPO_NAME=$(echo "$PARSED" | cut -d'/' -f2)
    if [ -n "$GH_USER" ] && [ -n "$REPO_NAME" ]; then
        SHOULD_SYNC=true
        step "Using specified user repo: $GH_USER/$REPO_NAME"
    else
        warn "Could not parse --user-repo URL: $USER_REPO"
        warn "Expected format: https://github.com/username/repo.git"
    fi
else
    prompt "Sync this profile with a GitHub repository? (Y/n): "
    read -r setup_profile </dev/tty
    if [ -z "$setup_profile" ] || [[ "$setup_profile" =~ ^[Yy] ]]; then
        SHOULD_SYNC=true
        prompt "GitHub username (your GitHub handle): "
        read -r GH_USER </dev/tty
        if [ -n "$GH_USER" ]; then
            prompt "Repository name (default: glitch-user-$GH_USER): "
            read -r REPO_NAME </dev/tty
            [ -z "$REPO_NAME" ] && REPO_NAME="glitch-user-$GH_USER"
        else
            SHOULD_SYNC=false
        fi
    fi
fi

if [ "$SHOULD_SYNC" = true ] && [ -n "$GH_USER" ]; then
    cd "$USER_DIR"
    # Force main branch for new user dirs (never master).
    # git >= 2.28 supports `git init -b <name>`; older git falls back to init + rename.
    if git init -b main >/dev/null 2>&1; then
        :
    else
        git init >/dev/null
        git symbolic-ref HEAD refs/heads/main 2>/dev/null || git branch -m main 2>/dev/null || true
    fi
    git add -A >/dev/null
    git commit -m "initial user profile" >/dev/null 2>&1 || true
    local_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
    git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git" 2>/dev/null

    # Auto-detect the primary (default) branch of the remote
    remote_head=$(git ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/ {sub(/refs\/heads\//, "", $2); print $2}')
    if [ -n "$remote_head" ]; then
        default_branch="$remote_head"
        # List all remote branches; if more than one, prompt the user to pick
        branch_list=$(git ls-remote --heads origin 2>/dev/null | sed 's|.*refs/heads/||' | sort -u)
        branch_count=$(printf '%s\n' "$branch_list" | grep -c . 2>/dev/null || echo "0")
        if [ "$branch_count" -gt 1 ]; then
            echo ""
            warn "Remote repo has multiple branches:"
            i=1
            while IFS= read -r b; do
                marker=""
                [ "$b" = "$default_branch" ] && marker=" (primary)"
                echo "    [$i] $b$marker"
                i=$((i+1))
            done <<< "$branch_list"
            prompt "Which branch to use? (Enter=$default_branch): "
            read -r branch_choice </dev/tty
            if [ -n "$branch_choice" ]; then
                chosen=$(echo "$branch_list" | sed -n "${branch_choice}p" 2>/dev/null)
                if [ -n "$chosen" ]; then
                    default_branch="$chosen"
                else
                    warn "Invalid choice, using primary: $default_branch"
                fi
            fi
        fi
        if [ "$local_branch" != "$default_branch" ]; then
            git branch -m "$default_branch" 2>/dev/null
        fi
        if git pull origin "$default_branch" --allow-unrelated-histories 2>/dev/null; then
            success "User profile synced from GitHub (branch: $default_branch)"
            git branch --set-upstream-to="origin/$default_branch" "$default_branch" 2>/dev/null
        else
            warn "Remote repository not found (or pull failed)."
            echo "  Local profile ready. Push later:"
            echo "    cd $USER_DIR && git push -u origin $default_branch"
        fi
    else
        warn "Remote not found. Profile is local-only."
        echo "  Push later:"
        echo "    cd $USER_DIR && git push -u origin $local_branch"
    fi
else
    echo "  Profile stays local-only (no GitHub sync)."
    echo "  To sync later: cd $USER_DIR && git init -b main && git remote add origin <url> && git push"
fi

# 6. Verify installation
header "Verifying installation..."
cd "$INSTALL_DIR"

if command -v node >/dev/null 2>&1; then
    if node scripts/check-install.mjs 2>&1; then
        :
    else
        warn "Some checks did not pass. Review the report above."
        echo "  Items marked with ✗ under 'Core' indicate critical issues."
    fi
else
    # Basic file-existence checks when Node.js isn't available
    echo "  Node.js not found — running basic file checks..."
    
    BASIC_PASS=true
    
    # Check git repo
    if [ -d ".git" ]; then
        success "  ✓ Git repository found"
    else
        error "  ✗ Git repository missing"
        BASIC_PASS=false
    fi
    
    # Check opencode binary
    if [ -f "opencode/opencode" ] || [ -f "opencode/opencode.exe" ]; then
        success "  ✓ OpenCode binary found"
    else
        warn "  ⚠ OpenCode binary not found (downloaded on first launch)"
    fi
    
    # Check glitch-memorycore submodule
    if [ -f "glitch-memorycore/glitch.md" ]; then
        success "  ✓ glitch-memorycore submodule initialized"
    else
        error "  ✗ glitch-memorycore submodule not initialized"
        echo "    Run: git submodule update --init --recursive"
        BASIC_PASS=false
    fi
    
    # Check config templates
    CONFIG_DIR="config"
    if [ -d "$CONFIG_DIR" ]; then
        TEMPLATE_OK=true
        for tmpl in opencode-normal.json opencode-free.json opencode-local.json opencode-safe.json; do
            if [ ! -f "$CONFIG_DIR/$tmpl" ]; then
                TEMPLATE_OK=false
            fi
        done
        if [ "$TEMPLATE_OK" = true ]; then
            success "  ✓ Config templates found"
        else
            warn "  ⚠ Some config templates missing"
        fi
    else
        warn "  ⚠ config/ directory missing"
    fi
    
    # Check launch script
    if [ -f "launch-glitch.sh" ]; then
        success "  ✓ Launch script found"
    else
        error "  ✗ launch-glitch.sh not found"
        BASIC_PASS=false
    fi
    
    # Check user profile
    if [ -f "user/main-memory.md" ]; then
        success "  ✓ User profile initialized"
    else
        warn "  ⚠ User profile incomplete"
    fi
    
    echo ""
    if [ "$BASIC_PASS" = true ]; then
        success "  Basic checks passed."
    else
        error "  Some critical checks failed. Review above."
    fi
    echo ""
    echo "  For a full verification, install Node.js and run:"
    echo "    cd $INSTALL_DIR && node scripts/check-install.mjs"
fi

# 6.5. Seed default plugins into user/plugins.json (additive merge)
header "Seeding default plugins..."
cd "$INSTALL_DIR"
if command -v node >/dev/null 2>&1; then
    if seed_output=$(node scripts/plugin.mjs seed 2>&1); then
        success "Seeded default plugins. Edit user/plugins.json to customize."
        if [ -n "$seed_output" ]; then
            echo "  $seed_output"
        fi
    else
        warn "Plugin seed returned non-zero (continuing): $seed_output"
    fi
else
    warn "Node.js not found — skipping plugin seed (will run on first launch)."
fi

# 7. Launch
if [ "$NO_LAUNCH" = false ]; then
    header "Launch Glitch Pie"
    prompt "Launch Glitch now? (Y/n): "
    read -r launch </dev/tty
    if [ -z "$launch" ] || [[ "$launch" =~ ^[Yy] ]]; then
        step "Starting Glitch Pie..."
        cd "$INSTALL_DIR"
        echo ""
        echo "First launch note: Node.js and the Pi engine are installed now"
        echo "(one-time, large download). This terminal runs the TUI directly."
        echo ""
        # Foreground launch, NOT nohup: the TUI needs this terminal, and the
        # first-run engine install needs an interactive (TTY) launch so
        # launch-unified.mjs's dependency installer actually runs. A detached
        # (non-TTY) first launch would skip the install and leave the engine
        # missing. When the TUI exits, control returns to this installer.
        ./launch-glitch.sh --mode pi
        echo ""
        success "Glitch Pie exited. To launch again: cd $INSTALL_DIR && ./launch-glitch.sh"
    fi
fi

# Completion
# 7.5. Desktop shortcut offer (skipped when --no-shortcut is set)
if [ "$NO_SHORTCUT" = false ]; then
    header "Desktop shortcut"
    offer_desktop_shortcut || warn "Desktop shortcut offer failed (continuing)."
fi

if [ "$INSTALL_ISSUES" = true ]; then
    echo ""
    warn "Some components couldn't be downloaded during install."
    warn "  Issues logged to: $INSTALL_DIR/data/install-issues.md"
    warn "  Glitch will review and attempt to fix these on first launch."
    warn "  Manual fix: cd $INSTALL_DIR && git submodule update --init --recursive"
    echo ""
fi

header "Installation Complete!"
cat <<EOF
Glitch Pie is installed at: $INSTALL_DIR

Next steps:
  • Launch:        cd $INSTALL_DIR && ./launch-glitch.sh
  • Pi TUI:       cd $INSTALL_DIR && ./launch-glitch.sh --mode pi
  • Web UI:       start glitch, then pick the Web interface (stack on :8787)
  • Update:        Re-run this installer (it will pull latest)
  • User sync:     cd $INSTALL_DIR/user && git add -A && git commit -m 'update' && git push  (after making changes)

Documentation: https://github.com/Cothek/glitch-pi
EOF

# Copy the install log into the install dir now that it exists.
if [ -f "$LOG_FILE" ] && [ -d "$INSTALL_DIR" ]; then
    cp "$LOG_FILE" "$INSTALL_DIR/install.log" 2>/dev/null || true
    step "Install log: $INSTALL_DIR/install.log"
fi