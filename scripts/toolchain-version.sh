#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <UV_VERSION|PYTHON_VERSION> <build-template.sh>" >&2
  exit 2
fi
case "$1" in
  UV_VERSION|PYTHON_VERSION) ;;
  *) echo "error: unsupported toolchain pin: $1" >&2; exit 2 ;;
esac

# Read a literal pin only. Sourcing the template would execute a rootfs build.
awk -v pin="$1" '
  $0 ~ "^[[:space:]]*(export[[:space:]]+)?" pin "[[:space:]]*=" {
    count++
    if ($0 !~ "^" pin "=\"[0-9]+\\.[0-9]+\\.[0-9]+\"$") {
      invalid = 1
    }
    split($0, parts, "\"")
    version = parts[2]
  }
  END {
    if (invalid || count != 1 ||
        (pin == "PYTHON_VERSION" && version !~ /^3\.[0-9]+\.[0-9]+$/)) {
      print "error: expected one exact " pin "=\"x.y.z\" pin in " FILENAME > "/dev/stderr"
      exit 1
    }
    print version
  }
' "$2"
