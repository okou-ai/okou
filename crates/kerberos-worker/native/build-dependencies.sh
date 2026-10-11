#!/usr/bin/env bash
# Reconstructible build-time cache only; never supplies a runtime override.
set -euo pipefail
recipe_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
output=$1
arch=$2
case "$arch" in x86_64|aarch64) ;; *) exit 1 ;; esac
case "$(uname -m)" in
  x86_64) host=x86_64; zig_sha=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239 ;;
  aarch64) host=aarch64; zig_sha=958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f ;;
  *) exit 1 ;;
esac
krb5_sha=3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13
recipe_sha=$(sha256sum "$recipe_dir/build-dependencies.sh" | awk '{print $1}')
library_key=$(printf '%s\n' "$krb5_sha" "$zig_sha" "$arch" "$host" "$recipe_sha" "${KERBEROS_NATIVE_BUILD_ENV:-}" | sha256sum | awk '{print $1}')
started=$SECONDS
mkdir -p "$output"
output=$(cd -- "$output" && pwd -P)
cache=${KERBEROS_NATIVE_CACHE_DIR:-"$output/cache"}
[[ ! -L "$cache" ]] || exit 1
mkdir -p "$cache"
cache=$(cd -- "$cache" && pwd -P)
entry="$cache/$library_key"
[[ ! -L "$entry" && ! -L "$entry.lock" ]] || exit 1
# The lock is outside the completed entry, so restoration/reconstruction never
# replaces an inode held by another writer. A killed writer releases it.
exec 9>"$entry.lock"
flock 9
mkdir -p "$entry"
fetch() {
  local url=$1 sha=$2 file=$3
  [[ ! -L "$file" && ! -L "$file.part" ]] || return 1
  if [[ -f "$file" ]] && ! printf '%s  %s\n' "$sha" "$file" | sha256sum --check --status; then
    echo "discarding corrupt pinned native archive: ${file##*/}" >&2
    rm -- "$file"
  fi
  if [[ ! -f "$file" ]]; then
    curl --fail --silent --show-error --location --proto '=https' --max-time 120 \
      --retry 3 --retry-delay 2 --retry-max-time 60 "$url" -o "$file.part"
    printf '%s  %s\n' "$sha" "$file.part" | sha256sum --check --status
    mv -- "$file.part" "$file"
  fi
  printf '%s  %s\n' "$sha" "$file" | sha256sum --check --status
}
fetch "https://ziglang.org/download/0.15.2/zig-$host-linux-0.15.2.tar.xz" "$zig_sha" "$entry/zig.tar.xz"
fetch https://kerberos.org/dist/krb5/1.22/krb5-1.22.2.tar.gz "$krb5_sha" "$entry/krb5.tar.gz"

# Extract from the pinned archives each time, rather than trusting cached SDK
# executables/source trees. Only the small generated link products are reused.
rm -rf -- "$output/zig-$host-linux-0.15.2" "$output/krb5-1.22.2" "$output/build"
tar -xJf "$entry/zig.tar.xz" -C "$output"
tar -xzf "$entry/krb5.tar.gz" -C "$output"
zig="$output/zig-$host-linux-0.15.2/zig"
source="$output/krb5-1.22.2"
build="$output/build"
mkdir -p "$build"
libraries=(libgssapi_krb5.a libkrb5.a libk5crypto.a libcom_err.a libkrb5support.a)

safe_package() {
  # The producer dereferences upstream archive symlinks. Accept only regular
  # files/directories inside the three explicit package surfaces on restore.
  tar -tzf "$1" | LC_ALL=C awk '
    $0 !~ /^include\/([A-Za-z0-9_+.-]+\/)*[A-Za-z0-9_+.-]*$/ &&
    $0 !~ /^util\/profile\/(profile.h|prof_err.h)$/ &&
    $0 !~ /^lib\/lib(gssapi_krb5|krb5|k5crypto|com_err|krb5support)\.a$/ { bad=1 }
    { n=split($0, parts, "/"); for (i=1; i<=n; i++) if (parts[i]=="." || parts[i]=="..") bad=1 }
    END { exit bad }
  ' && tar -tvzf "$1" | LC_ALL=C awk '$1 !~ /^[-d]/ { bad=1 } END { exit bad }'
}
complete_products() {
  local library header
  for library in "${libraries[@]}"; do [[ -f "$build/lib/$library" && -s "$build/lib/$library" ]] || return 1; done
  # The helper's public include chain needs these generated headers; the fresh
  # source archive does not provide them when a restored package is partial.
  for header in include/krb5/krb5.h include/com_err.h \
    include/gssapi/gssapi.h include/gssapi/gssapi_krb5.h include/gssapi/gssapi_ext.h \
    util/profile/profile.h util/profile/prof_err.h; do
    [[ -f "$build/$header" && -s "$build/$header" ]] || return 1
  done
}
hit=false
if [[ -f "$entry/libraries.tar.gz" && -f "$entry/complete" && ! -L "$entry/libraries.tar.gz" && ! -L "$entry/complete" ]]; then
  package_sha=$(sha256sum "$entry/libraries.tar.gz" | awk '{print $1}')
  if [[ "$(cat "$entry/complete")" == "$library_key $package_sha" ]] && safe_package "$entry/libraries.tar.gz"; then
    tar -xzf "$entry/libraries.tar.gz" -C "$build"
    if complete_products; then hit=true; fi
  fi
fi
if [[ "$hit" == false ]]; then
  echo "native dependency cache miss: $library_key" >&2
  # Invalidate completion before rebuilding, including after an interrupted
  # configure/make. A lone archive never counts as a complete product.
  rm -f -- "$entry/complete" "$entry/complete.part" "$entry/libraries.tar.gz.part"
  rm -rf -- "$build"
  mkdir -p "$build" "$output/tmp"
  # Ambient Autoconf probes/options and make controls can change the products
  # without changing their identity. Pass only executable/temp/compiler paths;
  # all recipe flags and cross-probe answers below remain explicit arguments.
  build_env=(env -i "PATH=$PATH" LC_ALL=C CONFIG_SITE=/dev/null
    "TMPDIR=${TMPDIR:-$output/tmp}"
    "ZIG_GLOBAL_CACHE_DIR=${ZIG_GLOBAL_CACHE_DIR:-$output/zig-cache}"
    "ZIG_LOCAL_CACHE_DIR=${ZIG_LOCAL_CACHE_DIR:-$output/zig-local-cache}")
  (
    cd -- "$build"
    "${build_env[@]}" "$source/src/configure" --build="$host-pc-linux-gnu" --host="$arch-linux-musl" \
      --prefix=/kerberos-worker-build-only --enable-static --disable-shared --disable-thread-support --disable-pkinit \
      --without-keyutils --without-libedit --without-ldap --without-lmdb --with-crypto-impl=builtin \
      --with-tls-impl=no --with-spake-openssl=no --without-system-verto --disable-dns-for-realm \
      "CC=$zig cc -target $arch-linux-musl" "AR=$zig ar" "RANLIB=$zig ranlib" \
      "CFLAGS=-O2 -ffile-prefix-map=$output=/kerberos-worker-build-only" 'CPPFLAGS=' 'LDFLAGS=' \
      ac_cv_func_res_nsearch=no ac_cv_func_res_search=no krb5_cv_attr_constructor_destructor=yes,yes ac_cv_printf_positional=yes
    for component in util/et include util/support util/profile lib/crypto lib/krb5 lib/gssapi; do
      "${build_env[@]}" make -j 2 -C "$component"
    done
  )
  complete_products
  # Keep OUT_DIR paths out of reusable products, including configure's prefix
  # and compiler source locations. Generated Makefiles/stamps are not link inputs.
  mapfile -t package_files < <(cd -- "$build" && find -L include -type f -name '*.h' | LC_ALL=C sort)
  package_files+=(util/profile/profile.h util/profile/prof_err.h)
  for library in "${libraries[@]}"; do package_files+=("lib/$library"); done
  tar -chzf "$entry/libraries.tar.gz.part" -C "$build" "${package_files[@]}"
  safe_package "$entry/libraries.tar.gz.part"
  package_sha=$(sha256sum "$entry/libraries.tar.gz.part" | awk '{print $1}')
  mv -- "$entry/libraries.tar.gz.part" "$entry/libraries.tar.gz"
  printf '%s %s\n' "$library_key" "$package_sha" > "$entry/complete.part"
  mv -- "$entry/complete.part" "$entry/complete"
fi
cache_bytes=$(du -sb "$entry" | awk '{print $1}')
printf 'cargo::warning=Kerberos native dependencies: hit=%s elapsed=%ss bytes=%s key=%s\n' "$hit" "$((SECONDS-started))" "$cache_bytes" "$library_key"
