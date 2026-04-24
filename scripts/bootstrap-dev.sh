#!/usr/bin/env bash
set -euo pipefail

TAURI_CLI_VERSION="2.0.0"
NODE_MIN_VERSION=18

echo "==> CDP Launcher — dev environment bootstrap"
echo ""

# ── Xcode Command Line Tools ─────────────────────────────────────────────────
if ! xcode-select -p &>/dev/null; then
  echo "[!] Xcode Command Line Tools not found. Installing..."
  xcode-select --install
  echo "    Re-run this script after the Xcode CLT installer completes."
  exit 1
fi
echo "[✓] Xcode Command Line Tools: $(xcode-select -p)"

# ── Rustup / Rust ─────────────────────────────────────────────────────────────
if ! command -v rustup &>/dev/null; then
  echo "[→] rustup not found — installing via rustup.rs..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
  echo "[✓] rustup installed"
else
  echo "[✓] rustup: $(rustup --version 2>&1 | head -1)"
fi

# Ensure cargo is on PATH
if ! command -v cargo &>/dev/null; then
  source "$HOME/.cargo/env"
fi
echo "[✓] cargo: $(cargo --version)"

# ── Node ≥ 18 ─────────────────────────────────────────────────────────────────
install_node_via_nvm() {
  echo "[→] Installing nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
  echo "[→] Installing Node LTS via nvm..."
  nvm install --lts
  nvm use --lts
}

# Load nvm if it exists but node isn't on PATH
if ! command -v node &>/dev/null; then
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$NVM_DIR/nvm.sh"
  fi
fi

if ! command -v node &>/dev/null; then
  echo "[→] Node not found — installing via nvm..."
  install_node_via_nvm
else
  NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
    echo "[!] Node $(node --version) is below minimum v${NODE_MIN_VERSION}. Upgrading via nvm..."
    install_node_via_nvm
  else
    echo "[✓] node: $(node --version)"
  fi
fi
echo "[✓] npm: $(npm --version)"

# ── tauri-cli ────────────────────────────────────────────────────────────────
if cargo tauri --version &>/dev/null 2>&1; then
  INSTALLED=$(cargo tauri --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ "$INSTALLED" = "$TAURI_CLI_VERSION" ]; then
    echo "[✓] tauri-cli: $INSTALLED (matches pinned version)"
  else
    echo "[→] tauri-cli $INSTALLED found, pinned to $TAURI_CLI_VERSION — reinstalling..."
    cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked
  fi
else
  echo "[→] Installing tauri-cli@${TAURI_CLI_VERSION}..."
  cargo install tauri-cli --version "$TAURI_CLI_VERSION" --locked
fi
echo "[✓] tauri-cli: $(cargo tauri --version 2>&1 | head -1)"

# ── npm deps ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "[→] Installing npm dependencies..."
cd "$REPO_ROOT"
npm install
echo "[✓] npm dependencies installed"

echo ""
echo "============================================================"
echo "  Ready. Run \`make dev\` to launch the Tauri dev window."
echo "============================================================"
