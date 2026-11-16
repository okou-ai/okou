#!/usr/bin/env bash
# Run the existing native suite against Release with a disposable signing key.
# Requires the README's JDK/SDK setup and KVM on Linux. Extra arguments go to Gradle.
set -euo pipefail
umask 077
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
native_status=0
exit_status=0
trap '
  exit_status=$?
  rm -rf "$work"
  if (( native_status != 0 )); then
    exit "$native_status"
  fi
  exit "$exit_status"
' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

keytool -genkeypair -keystore "$work/test.p12" -storetype PKCS12 \
  -storepass android -keypass android -alias release-test \
  -keyalg RSA -keysize 2048 -validity 1 \
  -dname 'CN=Okou Android Release Test' -noprompt

cd "$root"
export ANDROID_HOME=${ANDROID_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/android-sdk}
mkdir -p "$root/build/reports/release"
artifacts=$(mktemp -d "$root/build/reports/release/run.XXXXXX")
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'release-directory=%s\n' "$artifacts" >> "$GITHUB_OUTPUT"
fi
echo "Release test artifacts: $artifacts"
# Screenshot recipes add a temporary driver, not another production ABI. Check
# the baseline suite's contract before compiling that optional overlay below.
abi_arguments=()
for argument in "$@"; do
  case "$argument" in
    -Pokou.screenshotScenarioDir=*) ;;
    *) abi_arguments+=("$argument") ;;
  esac
done
./gradlew :app:generateNativeTestKeepRules --no-daemon "${abi_arguments[@]}"
if ! cmp app/build/generated/native-test.keep app/src/main/keepRules/native-instrumentation.keep; then
  echo 'Native ABI changed. Review and copy app/build/generated/native-test.keep to app/src/main/keepRules/native-instrumentation.keep.' >&2
  exit 1
fi
bash ../.github/scripts/artifacts/build-okou-android-apk.sh \
  "$(cat version.txt)" "$artifacts"
signing=(
  -Pandroid.injected.signing.store.file="$work/test.p12"
  -Pandroid.injected.signing.store.type=PKCS12
  -Pandroid.injected.signing.store.password=android
  -Pandroid.injected.signing.key.alias=release-test
  -Pandroid.injected.signing.key.password=android
)
./gradlew :app:assembleRelease :app:assembleReleaseAndroidTest \
  "${signing[@]}" --no-daemon "$@"
retain_pair() {
  local version
  version=$(cat version.txt)
  cp app/build/outputs/apk/release/app-release.apk "$artifacts/tested-app.apk"
  cp app/build/outputs/apk/androidTest/release/app-release-androidTest.apk "$artifacts/native-test.apk"
  gzip -n -c app/build/outputs/mapping/release/mapping.txt > "$artifacts/tested-app-mapping.txt.gz"
  gzip -n -c app/build/outputs/mapping/releaseAndroidTest/mapping.txt > "$artifacts/native-test-mapping.txt.gz"
  python3 scripts/verify-release-pair.py \
    "$artifacts/okou-android-$version-unsigned.apk" \
    "$artifacts/okou-android-$version-mapping.txt.gz" \
    "$artifacts/tested-app.apk" app/build/outputs/mapping/release/mapping.txt \
    "$artifacts/pair-identity.json"
}
retain_pair
python3 scripts/run-native-tests.py build/reports/instrumentation/logcat -- \
  ./gradlew :app:pixel2Api35ReleaseAndroidTest "${signing[@]}" --no-daemon "$@" || native_status=$?
# Recheck and retain the actual post-execution files, including on test timeout.
retain_pair
exit "$native_status"
