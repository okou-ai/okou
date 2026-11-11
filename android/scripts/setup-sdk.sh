#!/usr/bin/env bash
# Install the pinned command-line SDK on Linux/macOS; no emulator or IDE.
set -euo pipefail

accept=false
if [[ "${1:-}" == --accept-licenses ]]; then
  accept=true
  shift
fi
if [[ $# != 0 ]]; then
  echo 'Usage: bash android/scripts/setup-sdk.sh [--accept-licenses]' >&2
  exit 2
fi

sdk_root=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
tools_version=13114758
case "$(uname -s)" in
  Linux) platform=linux; checksum=7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee ;;
  Darwin) platform=mac; checksum=5673201e6f3869f418eeed3b5cb6c4be7401502bd0aae1b12a29d164d647a54e ;;
  *) echo 'Use Android Studio SDK Manager on this platform.' >&2; exit 2 ;;
esac
command -v java >/dev/null
command -v python3 >/dev/null
manager="$sdk_root/cmdline-tools/$tools_version/bin/sdkmanager"
if [[ ! -x "$manager" ]]; then
  if [[ -e "$sdk_root/cmdline-tools/$tools_version" ]]; then
    echo "Incomplete command-line tools installation at $sdk_root/cmdline-tools/$tools_version; inspect it before reinstalling." >&2
    exit 1
  fi
  mkdir -p "$sdk_root/cmdline-tools"
  staging=$(mktemp -d "$sdk_root/cmdline-tools/.setup.XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  curl --fail --location --silent --show-error \
    "https://dl.google.com/android/repository/commandlinetools-${platform}-${tools_version}_latest.zip" \
    --output "$staging/tools.zip"
  python3 - "$staging/tools.zip" "$checksum" <<'PY'
import hashlib
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
if hashlib.sha256(path.read_bytes()).hexdigest() != sys.argv[2]:
    raise SystemExit("Android command-line tools checksum mismatch")
PY
  unzip -q "$staging/tools.zip" -d "$staging/unpacked"
  mv "$staging/unpacked/cmdline-tools" "$sdk_root/cmdline-tools/$tools_version"
fi

export ANDROID_HOME="$sdk_root"
if [[ "$accept" == true ]]; then
  # A finite input avoids hiding sdkmanager failures behind yes/SIGPIPE.
  answers=$(mktemp "$sdk_root/.licenses.XXXXXX")
  trap 'rm -f "$answers"; if [[ -n "${staging:-}" ]]; then rm -rf "$staging"; fi' EXIT
  python3 -c 'print("y\n" * 100)' > "$answers"
  "$manager" --sdk_root="$sdk_root" --licenses < "$answers"
fi
"$manager" --sdk_root="$sdk_root" 'platform-tools' 'platforms;android-35' 'build-tools;35.0.0'
printf '\nAndroid SDK ready at %s\nExport ANDROID_HOME to this directory before building.\n' "$sdk_root"
