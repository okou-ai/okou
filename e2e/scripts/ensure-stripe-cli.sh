#!/usr/bin/env bash
set -euo pipefail

if command -v stripe >/dev/null 2>&1; then
  stripe --version
  exit 0
fi

version="1.41.2"

case "$(uname -s)" in
  Linux)
    os="linux"
    ;;
  *)
    echo "Unsupported Stripe CLI platform: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    arch="x86_64"
    sha256="35684521fc6c2d994e6461ef28330f2c77fbf7d588a7b93fee5e8d4aa52d0c65"
    ;;
  aarch64 | arm64)
    arch="arm64"
    sha256="04d86663e840ec1fc71ec0f1ccceb9345a5bd783614746f590b05e4bf1f61b9b"
    ;;
  *)
    echo "Unsupported Stripe CLI architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
download_script="${repo_root}/.github/scripts/download-verified.sh"
bash "$download_script" \
  "https://github.com/stripe/stripe-cli/releases/download/v${version}/stripe_${version}_${os}_${arch}.tar.gz" \
  "$sha256" \
  "$tmp_dir/stripe.tar.gz"
tar -xzf "$tmp_dir/stripe.tar.gz" -C "$tmp_dir"

install_dir="${STRIPE_CLI_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$install_dir"
cp "$tmp_dir/stripe" "$install_dir/stripe"
chmod 0755 "$install_dir/stripe"

if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$install_dir" >> "$GITHUB_PATH"
fi

export PATH="$install_dir:$PATH"
stripe --version
