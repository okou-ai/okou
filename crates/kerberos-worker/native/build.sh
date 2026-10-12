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
mkdir -p "$output" "$output/tmp" "$output/zig-cache" "$output/zig-local-cache"
export TMPDIR="$output/tmp" ZIG_GLOBAL_CACHE_DIR="$output/zig-cache" ZIG_LOCAL_CACHE_DIR="$output/zig-local-cache"
dependencies="$output/dependencies"
bash "$source_dir/build-dependencies.sh" "$dependencies" "$arch"
zig="$dependencies/zig-$host-linux-0.15.2/zig"
source="$dependencies/krb5-1.22.2"
build="$dependencies/build"
"$zig" cc -target "$arch-linux-musl" -std=c11 -O2 -Wall -Wextra -Werror -static \
  -I"$build/include" -I"$source/src/include" -I"$build/util/profile" \
  -I"$source/src/util/profile" -I"$source/src/lib/gssapi" \
  "$source_dir/worker.c" -L"$build/lib" -lgssapi_krb5 -lkrb5 -lk5crypto -lcom_err -lkrb5support \
  -o "$output/kerberos-worker"
if readelf -l "$output/kerberos-worker" | grep -q INTERP; then exit 1; fi
if readelf -d "$output/kerberos-worker" | grep -q NEEDED; then exit 1; fi
case "$arch" in
  x86_64) readelf -h "$output/kerberos-worker" | grep -q 'Machine:.*Advanced Micro Devices X86-64' ;;
  aarch64) readelf -h "$output/kerberos-worker" | grep -q 'Machine:.*AArch64' ;;
esac
# Versioned notices are part of the source package and the embedded Runner.
# A source/toolchain upgrade must update them rather than label old licenses new.
cmp -- "$source/NOTICE" "$source_dir/NOTICE-MIT"
cmp -- "$dependencies/zig-$host-linux-0.15.2/lib/libc/musl/COPYRIGHT" "$source_dir/NOTICE-musl"
cmp -- "$dependencies/zig-$host-linux-0.15.2/LICENSE" "$source_dir/NOTICE-Zig"
cp -- "$source_dir/NOTICE-MIT" "$source_dir/NOTICE-musl" "$source_dir/NOTICE-Zig" "$output/"
sha256sum "$output/kerberos-worker"
printf 'cargo::warning=Kerberos native package: elapsed=%ss helper-bytes=%s\n' "$((SECONDS-started))" "$(wc -c < "$output/kerberos-worker")"
