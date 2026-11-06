#!/bin/bash

# Simple setup script for dev container (based on vm0 setup)
set -e

echo "🚀 Setting up dev container..."

# Get the workspace directory dynamically
# Script is in .devcontainer/setup.sh, so workspace is parent directory
WORKSPACE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "📁 Workspace directory: $WORKSPACE_DIR"

# Clear repo-local build caches when recreating the dev container so stale
# Turbo/Next artifacts do not leak across environments.
echo "🧹 Cleaning Turbo/Next caches..."
TURBO_WORKSPACE_DIR="$WORKSPACE_DIR/turbo"
if [ -d "$TURBO_WORKSPACE_DIR" ]; then
  mapfile -t CACHE_DIRS < <(
    find "$TURBO_WORKSPACE_DIR" \
      \( -path '*/node_modules/*' -o -path "$TURBO_WORKSPACE_DIR/node_modules" \) -prune -o \
      \( -name .next -o -name .turbo \) -type d -print
  )

  if [ ${#CACHE_DIRS[@]} -eq 0 ]; then
    echo "✓ No repo-local Turbo/Next caches found"
  else
    rm -rf "${CACHE_DIRS[@]}"
    echo "✓ Removed ${#CACHE_DIRS[@]} repo-local Turbo/Next cache directories"
  fi
else
  echo "✓ Turbo workspace not found, skipping cache cleanup"
fi

# PostgreSQL and pgvector are provided by the vm0-dev image.
echo "🐘 Configuring PostgreSQL..."
sudo service postgresql start
sudo -u postgres psql -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE postgres PASSWORD 'postgres';"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT 1" | grep -qx 1
echo "✓ PostgreSQL password authentication ready"

if sudo -u postgres psql -h /var/run/postgresql -d postgres -Atqc "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'" | grep -qx 1; then
  echo "✓ pgvector extension available to PostgreSQL"
else
  echo "ERROR: pgvector extension is not available to PostgreSQL" >&2
  exit 1
fi

# Generate locale for UTF-8 support
echo "🌐 Setting up locale..."
sudo locale-gen en_US.UTF-8 2>/dev/null || true
sudo update-locale LANG=en_US.UTF-8 2>/dev/null || true
echo "✓ Locale configured"

# Add vm7.ai domains to /etc/hosts (Caddy reverse proxy listens on 127.0.0.1)
echo "🌐 Configuring vm7.ai hosts..."
if ! grep -q "vm7.ai" /etc/hosts 2>/dev/null; then
  echo "127.0.0.1 vm7.ai www.vm7.ai app.vm7.ai platform.vm7.ai" | sudo tee -a /etc/hosts > /dev/null
  echo "✓ vm7.ai domains added to /etc/hosts"
else
  echo "✓ vm7.ai domains already in /etc/hosts"
fi

# Setup directories - fix ownership for all mounted volumes
sudo mkdir -p \
  /home/vscode/.local/bin \
  /home/vscode/.local/lib \
  /home/vscode/.pki \
  /home/vscode/.codex \
  /home/vscode/.codex-switch \
  /home/vscode/.zed_server
sudo chown -R vscode:vscode \
  /home/vscode/.config \
  /home/vscode/.cache \
  /home/vscode/.local \
  /home/vscode/.pki \
  /home/vscode/.cloudflared \
  /home/vscode/.codex \
  /home/vscode/.codex-switch \
  /home/vscode/.zed_server
echo "✓ User-local mounted directories ready"

# Install the exact uv version required by the mitm-addon project.
UV_PROJECT_FILE="$WORKSPACE_DIR/crates/runner/mitm-addon/pyproject.toml"
UV_VERSION="$(
  python3 - "$UV_PROJECT_FILE" <<'PY'
import re
import sys
import tomllib
from pathlib import Path

project_file = Path(sys.argv[1])
with project_file.open("rb") as file:
    project = tomllib.load(file)

required_version = project.get("tool", {}).get("uv", {}).get("required-version")
match = re.fullmatch(r"==(\d+\.\d+\.\d+)", required_version or "")
if match is None:
    raise SystemExit(
        f"ERROR: {project_file} must define an exact [tool.uv] required-version"
    )

print(match.group(1))
PY
)"

if command -v uv > /dev/null 2>&1 \
  && [ "$(uv --version | awk 'NR == 1 { print $2 }')" = "$UV_VERSION" ]; then
  echo "✓ uv $UV_VERSION already installed"
else
  echo "📦 Installing uv $UV_VERSION..."
  curl --proto '=https' --tlsv1.2 -LsSf "https://astral.sh/uv/$UV_VERSION/install.sh" \
    | env UV_UNMANAGED_INSTALL="$HOME/.local/bin" sh
  hash -r

  if ! command -v uv > /dev/null 2>&1 \
    || [ "$(uv --version | awk 'NR == 1 { print $2 }')" != "$UV_VERSION" ]; then
    echo "ERROR: uv $UV_VERSION was installed but is not effective on PATH" >&2
    exit 1
  fi
  echo "✓ uv $UV_VERSION installed"
fi

# Create ~/.claude symlink to ~/.config/claude for Claude Code IDE integration
# The VS Code extension uses ~/.claude/ide/ while CLI respects CLAUDE_CONFIG_DIR
if [ ! -L "$HOME/.claude" ]; then
  rm -rf "$HOME/.claude"
  mkdir -p "$HOME/.config/claude"
  ln -s "$HOME/.config/claude" "$HOME/.claude"
  echo "✓ Linked ~/.claude to ~/.config/claude"
fi

if [ ! -L "$HOME/.claude/downloads" ]; then
  rm -rf "$HOME/.claude/downloads"
  mkdir -p "$HOME/.cache/claude"
  ln -s "$HOME/.cache/claude" "$HOME/.claude/downloads"
  echo "✓ Linked ~/.claude/downloads to ~/.cache/claude"
fi

# Install lefthook git hooks for pre-commit checks
echo "🪝 Installing lefthook git hooks..."
cd "$WORKSPACE_DIR/turbo" && lefthook install
echo "✓ Lefthook hooks installed"

# Ensure VNC dependencies are installed (startup moved to start-vnc.sh via postStartCommand)
echo "🖥️ Checking VNC dependencies..."
MISSING=()
command -v x11vnc >/dev/null 2>&1 || MISSING+=(x11vnc)
command -v Xvfb >/dev/null 2>&1 || MISSING+=(xvfb)
command -v i3 >/dev/null 2>&1 || MISSING+=(i3)
command -v websockify >/dev/null 2>&1 || MISSING+=(novnc)
command -v xrandr >/dev/null 2>&1 || MISSING+=(x11-xserver-utils)
if [ ${#MISSING[@]} -gt 0 ]; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING[@]}"
fi
echo "✓ VNC dependencies ready"

echo "✅ Dev container setup complete!"
