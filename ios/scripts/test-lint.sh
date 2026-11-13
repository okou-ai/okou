#!/usr/bin/env bash
# Exercise the real lint entry point with temporary sources and installed SwiftLint.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ios_root=$(cd "$script_dir/.." && pwd)
if [[ -z "${SWIFTLINT_BIN:-}" ]]; then
  SWIFTLINT_BIN=$(bash "$script_dir/install-swiftlint.sh" --path-only)
fi
export SWIFTLINT_BIN
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
fixture="$test_root/ios"
mkdir -p "$fixture/scripts" "$fixture/Okou" "$fixture/Push"
cp "$ios_root/.swiftlint.yml" "$ios_root/.swiftlint-version" "$fixture/"
cp "$script_dir/lint.sh" "$fixture/scripts/"
mkdir -p "$fixture/Tools"
cp -R "$ios_root/Tools/SwiftLint" "$fixture/Tools/"

test_paths=(
  OkouTests
  Packages/ChatData/Sources/ChatDataTestSupport
  Packages/ChatData/Tests
  Packages/ChatDomain/Tests
)
production_paths=(Okou Push Packages/ChatData/Sources/ChatData Packages/ChatDomain/Sources/ChatDomain)
for path in "${test_paths[@]}"; do
  mkdir -p "$fixture/$path"
  cp "$ios_root/$path/.swiftlint.yml" "$fixture/$path/"
  # Known fixture data can be forced; all other rules still apply here.
  printf 'let fixtureValue = try! decodeFixture() as! Int\n' > "$fixture/$path/Fixture.swift"
done
for path in "${production_paths[@]}"; do
  mkdir -p "$fixture/$path"
  printf 'let value = 1\n' > "$fixture/$path/Valid.swift"
done
# Generated and compiler output do not belong to the lint surface.
mkdir -p "$fixture/Packages/ChatData/.build"
printf 'let value = try! decode()\n' > "$fixture/Okou/Colors.generated.swift"
printf 'let value = try! decode()\n' > "$fixture/Packages/ChatData/.build/Generated.swift"

run_lint() {
  bash "$fixture/scripts/lint.sh" > "$test_root/lint.log" 2>&1
}
run_lint
for path in "${production_paths[@]}"; do
  printf 'let value = try! decode() as! Int\n' > "$fixture/$path/Invalid.swift"
done
if GITHUB_ACTIONS=true run_lint; then
  echo 'Production force operations passed strict lint.' >&2
  exit 1
fi
for path in "${production_paths[@]}"; do
  grep -F "$path/Invalid.swift" "$test_root/lint.log" >/dev/null
  rm "$fixture/$path/Invalid.swift"
done
grep -F '::error' "$test_root/lint.log" >/dev/null

for path in "${test_paths[@]}"; do
  printf 'import Foundation\nimport Foundation\n' > "$fixture/$path/Duplicate.swift"
done
if run_lint; then
  echo 'Test-directory overrides disabled unrelated rules.' >&2
  exit 1
fi
for path in "${test_paths[@]}"; do
  grep -F "$path/Duplicate.swift" "$test_root/lint.log" >/dev/null
  rm "$fixture/$path/Duplicate.swift"
done

# The production-only state rule must be enabled by the real root config.
for path in "${production_paths[@]}"; do
  printf 'var sharedState = 0\n' > "$fixture/$path/GlobalState.swift"
done
if run_lint; then
  echo 'Global production state passed the configured lint entry point.' >&2
  exit 1
fi
for path in "${production_paths[@]}"; do
  grep -F "$path/GlobalState.swift" "$test_root/lint.log" >/dev/null
  rm "$fixture/$path/GlobalState.swift"
done
grep -F 'okou_global_mutable_state' "$test_root/lint.log" >/dev/null
printf 'func start() { _ = Task { throw CancellationError() } }\n' > "$fixture/Okou/DiscardedTask.swift"
if run_lint; then
  echo 'An explicitly discarded throwing Task passed the configured lint entry point.' >&2
  exit 1
fi
grep -F 'okou_discarded_throwing_task' "$test_root/lint.log" >/dev/null
rm "$fixture/Okou/DiscardedTask.swift"
for path in "${test_paths[@]}"; do
  printf 'var fixtureState = 0\n' >> "$fixture/$path/Fixture.swift"
done
run_lint

printf 'only_rules: [\n' > "$fixture/.swiftlint.yml"
if run_lint; then
  echo 'Malformed lint configuration passed.' >&2
  exit 1
fi
printf 'only_rules: [nonexistent_rule]\n' > "$fixture/.swiftlint.yml"
if run_lint; then
  echo 'An unknown lint rule silently passed.' >&2
  exit 1
fi
cp "$ios_root/.swiftlint.yml" "$fixture/.swiftlint.yml"
printf '#!/usr/bin/env bash\nprintf "0.0.0\\n"\n' > "$test_root/wrong-version"
chmod +x "$test_root/wrong-version"
if SWIFTLINT_BIN="$test_root/wrong-version" run_lint; then
  echo 'A mismatched SwiftLint version passed.' >&2
  exit 1
fi
echo 'SwiftLint scope, strict failures, test overrides and version checks passed.'
