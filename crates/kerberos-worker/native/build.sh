#!/usr/bin/env bash
# Build-time only, hash-pinned source/toolchain. No runtime executable/library override.
set -euo pipefail
started=$SECONDS
unset ZIG_LIB_DIR CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH \
  LIBRARY_PATH COMPILER_PATH GCC_EXEC_PREFIX
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
output=$1
arch=$2
case "$arch" in x86_64|aarch64) ;; *) exit 1 ;; esac
host=$(uname -m)
case "$host" in x86_64|aarch64) ;; *) exit 1 ;; esac
export LC_ALL=C
mkdir -p "$output" "$output/tmp" "$output/zig-cache" "$output/zig-local-cache"
output=$(cd -- "$output" && pwd -P)
export TMPDIR="$output/tmp" ZIG_GLOBAL_CACHE_DIR="$output/zig-cache" ZIG_LOCAL_CACHE_DIR="$output/zig-local-cache"
# The final product has more inputs than the dependency libraries. Hash the
# entire native source package, including the recipes, pins, flags and notices.
inputs=(build.sh build-dependencies.sh isolation.h worker.c NOTICE-MIT NOTICE-musl NOTICE-Zig)
source_identity=$(cd -- "$source_dir" && sha256sum "${inputs[@]}")
helper_key=$(printf '%s\n' "$source_identity" "$host" "$arch" "${KERBEROS_NATIVE_BUILD_ENV:-}" | sha256sum | awk '{print $1}')
cache=${KERBEROS_NATIVE_CACHE_DIR:-"$output/cache"}
[[ ! -L "$cache" ]] || exit 1
mkdir -p "$cache"
cache=$(cd -- "$cache" && pwd -P)
entry="$cache/helper-$helper_key"
[[ ! -L "$entry" && ! -L "$entry.lock" ]] || exit 1
if [[ -e "$entry.lock" ]]; then
  [[ -f "$entry.lock" && $(stat -c %h "$entry.lock") == 1 ]] || exit 1
fi
# Keep this inode outside the reconstructible entry. Dependency builds own FD 9.
exec 8>"$entry.lock"
flock 8
products=(kerberos-worker NOTICE-MIT NOTICE-musl NOTICE-Zig)

valid_helper() {
  local directory=$1 file program_headers dynamic header
  for file in "${products[@]}"; do
    [[ -f "$directory/$file" && ! -L "$directory/$file" && $(stat -c %h "$directory/$file") == 1 ]] || return 1
  done
  [[ -s "$directory/kerberos-worker" && $(wc -c < "$directory/kerberos-worker") -le 16777216 ]] || return 1
  program_headers=$(readelf -l "$directory/kerberos-worker") || return 1
  dynamic=$(readelf -d "$directory/kerberos-worker") || return 1
  header=$(readelf -h "$directory/kerberos-worker") || return 1
  [[ "$program_headers" != *INTERP* && "$dynamic" != *NEEDED* ]] || return 1
  grep -q 'Type:.*EXEC ' <<< "$header" || return 1
  grep -q 'Class:.*ELF64' <<< "$header" || return 1
  case "$arch" in
    x86_64) grep -q 'Machine:.*Advanced Micro Devices X86-64' <<< "$header" || return 1 ;;
    aarch64) grep -q 'Machine:.*AArch64' <<< "$header" || return 1 ;;
  esac
  for file in NOTICE-MIT NOTICE-musl NOTICE-Zig; do cmp -- "$directory/$file" "$source_dir/$file" || return 1; done
}

receipt() {
  printf '%s\n' "$helper_key"
  (cd -- "$1" && sha256sum "${products[@]}")
}

hit=false
if [[ -f "$entry/complete" && ! -L "$entry/complete" && $(stat -c %h "$entry/complete") == 1 ]] && valid_helper "$entry"; then
  if [[ "$(cat "$entry/complete")" == "$(receipt "$entry")" ]]; then hit=true; fi
fi
if [[ "$hit" == true ]]; then
  for file in "${products[@]}"; do cp -- "$entry/$file" "$output/$file"; done
else
  # Nothing below the entry is trusted after a miss, including interrupted .part
  # files or symlink/directory substitutes. The external lock remains untouched.
  rm -rf -- "$entry"
  mkdir -p "$entry"
  dependencies="$output/dependencies"
  bash "$source_dir/build-dependencies.sh" "$dependencies" "$arch"
  zig="$dependencies/zig-$host-linux-0.15.2/zig"
  source="$dependencies/krb5-1.22.2"
  build="$dependencies/build"
  env -i "PATH=$PATH" LC_ALL=C "TMPDIR=$TMPDIR" \
    "ZIG_GLOBAL_CACHE_DIR=$ZIG_GLOBAL_CACHE_DIR" "ZIG_LOCAL_CACHE_DIR=$ZIG_LOCAL_CACHE_DIR" \
    "$zig" cc -target "$arch-linux-musl" -std=c11 -O2 -Wall -Wextra -Werror -static \
    -I"$build/include" -I"$source/src/include" -I"$build/util/profile" \
    -I"$source/src/util/profile" -I"$source/src/lib/gssapi" \
    "$source_dir/worker.c" -L"$build/lib" -lgssapi_krb5 -lkrb5 -lk5crypto -lcom_err -lkrb5support \
    -o "$output/kerberos-worker"
  # Versioned notices are part of the source package and the embedded Runner.
  # A source/toolchain upgrade must update them rather than label old licenses new.
  cmp -- "$source/NOTICE" "$source_dir/NOTICE-MIT"
  cmp -- "$dependencies/zig-$host-linux-0.15.2/lib/libc/musl/COPYRIGHT" "$source_dir/NOTICE-musl"
  cmp -- "$dependencies/zig-$host-linux-0.15.2/LICENSE" "$source_dir/NOTICE-Zig"
  cp -- "$source_dir/NOTICE-MIT" "$source_dir/NOTICE-musl" "$source_dir/NOTICE-Zig" "$output/"
  valid_helper "$output"
  for file in "${products[@]}"; do
    cp -- "$output/$file" "$entry/$file.part"
    mv -- "$entry/$file.part" "$entry/$file"
  done
  receipt "$entry" > "$entry/complete.part"
  mv -- "$entry/complete.part" "$entry/complete"
fi
sha256sum "$output/kerberos-worker"
printf 'cargo::warning=Kerberos native package: hit=%s elapsed=%ss helper-bytes=%s key=%s\n' "$hit" "$((SECONDS-started))" "$(wc -c < "$output/kerberos-worker")" "$helper_key"
