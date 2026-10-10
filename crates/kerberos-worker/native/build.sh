#!/usr/bin/env bash
# Build-time only, hash-pinned source/toolchain. No runtime executable/library override.
set -euo pipefail
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
output=$1
arch=$2
case "$arch" in x86_64|aarch64) ;; *) exit 1 ;; esac
case "$(uname -m)" in
  x86_64) host=x86_64; zig_sha=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239 ;;
  aarch64) host=aarch64; zig_sha=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f ;;
  *) exit 1 ;;
esac
mkdir -p "$output" "$output/tmp" "$output/zig-cache" "$output/zig-local-cache"
export TMPDIR="$output/tmp" ZIG_GLOBAL_CACHE_DIR="$output/zig-cache" ZIG_LOCAL_CACHE_DIR="$output/zig-local-cache"
fetch() {
  local url=$1 sha=$2 file=$3
  if [[ ! -f "$file" ]]; then
    # curl's transient retries include DNS errors; keep build recovery bounded.
    curl --fail --silent --show-error --location --proto '=https' --max-time 120 \
      --retry 3 --retry-delay 2 --retry-max-time 60 "$url" -o "$file.part"
    printf '%s  %s\n' "$sha" "$file.part" | sha256sum --check --status
    mv -- "$file.part" "$file"
  fi
  printf '%s  %s\n' "$sha" "$file" | sha256sum --check --status
}
fetch "https://ziglang.org/download/0.15.2/zig-$host-linux-0.15.2.tar.xz" "$zig_sha" "$output/zig.tar.xz"
krb5_sha=3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13
fetch https://kerberos.org/dist/krb5/1.22/krb5-1.22.2.tar.gz "$krb5_sha" "$output/krb5.tar.gz"
if [[ ! -d "$output/zig-$host-linux-0.15.2" ]]; then tar -xJf "$output/zig.tar.xz" -C "$output"; fi
if [[ ! -d "$output/krb5-1.22.2" ]]; then tar -xzf "$output/krb5.tar.gz" -C "$output"; fi
zig="$output/zig-$host-linux-0.15.2/zig"
source="$output/krb5-1.22.2"
# Cargo reruns this script when pins/flags change. A plain existing archive must
# never silently substitute libraries from the previous SDK/configuration.
script_sha=$(sha256sum "$source_dir/build.sh" | awk '{print $1}')
library_key=$(printf '%s\n' "$krb5_sha" "$zig_sha" "$arch" "$host" "$script_sha" | sha256sum | awk '{print $1}')
build="$output/build-$arch-$library_key"
mkdir -p "$build"
if [[ ! -f "$build/lib/libgssapi_krb5.a" ]]; then
  cd "$build"
  "$source/src/configure" --build="$host-pc-linux-gnu" --host="$arch-linux-musl" \
    --prefix="$build/install" --enable-static --disable-shared --disable-thread-support --disable-pkinit \
    --without-keyutils --without-libedit --without-ldap --without-lmdb --with-crypto-impl=builtin \
    --with-tls-impl=no --with-spake-openssl=no --without-system-verto --disable-dns-for-realm \
    "CC=$zig cc -target $arch-linux-musl" "AR=$zig ar" "RANLIB=$zig ranlib" 'CFLAGS=-O2' \
    ac_cv_func_res_nsearch=no ac_cv_func_res_search=no krb5_cv_attr_constructor_destructor=yes,yes ac_cv_printf_positional=yes
  # Upstream build-host compile_et generation precedes generated include tables.
  for component in util/et include util/support util/profile lib/crypto lib/krb5 lib/gssapi; do
    make -j 2 -C "$component"
  done
fi
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
cmp -- "$output/zig-$host-linux-0.15.2/lib/libc/musl/COPYRIGHT" "$source_dir/NOTICE-musl"
cmp -- "$output/zig-$host-linux-0.15.2/LICENSE" "$source_dir/NOTICE-Zig"
cp -- "$source_dir/NOTICE-MIT" "$source_dir/NOTICE-musl" "$source_dir/NOTICE-Zig" "$output/"
sha256sum "$output/kerberos-worker"
