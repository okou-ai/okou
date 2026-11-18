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
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
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

for path in "${production_paths[@]}" "${test_paths[@]}"; do
  cat > "$fixture/$path/DuplicateCondition.swift" <<'SWIFT'
func classify(_ value: Int) -> Int {
  if value == 1 { return 10 }
  else if value == 1 { return 20 }
  return 0
}
SWIFT
done
if run_lint; then
  echo 'Duplicate conditions passed the configured lint entry point.' >&2
  exit 1
fi
for path in "${production_paths[@]}" "${test_paths[@]}"; do
  grep -F "$path/DuplicateCondition.swift" "$test_root/lint.log" >/dev/null
  rm "$fixture/$path/DuplicateCondition.swift"
done
grep -F 'duplicate_conditions' "$test_root/lint.log" >/dev/null

for path in "${production_paths[@]}" "${test_paths[@]}"; do
  cat > "$fixture/$path/Setter.swift" <<'SWIFT'
struct Setting {
  var value: Int {
    get { 1 }
    set { persist(value) }
  }
}
SWIFT
done
if run_lint; then
  echo 'An unused setter value passed the default safety checks.' >&2
  exit 1
fi
for path in "${production_paths[@]}" "${test_paths[@]}"; do
  grep -F "$path/Setter.swift" "$test_root/lint.log" >/dev/null
  rm "$fixture/$path/Setter.swift"
done
grep -F 'unused_setter_value' "$test_root/lint.log" >/dev/null

# SourceKit-backed default checks must run through the real entry point.
cat > "$fixture/Okou/Statement.swift" <<'SWIFT'
func recover() {
  do { try operation() }
  catch { report(error) }
}
SWIFT
if run_lint; then
  echo 'A misplaced catch passed the SourceKit-backed default check.' >&2
  exit 1
fi
grep -F 'statement_position' "$test_root/lint.log" >/dev/null
rm "$fixture/Okou/Statement.swift"

# The real strict entry point must enforce total file length in every target,
# including directories whose nested configs permit force operations.
file_length_paths=("${production_paths[@]}" "${test_paths[@]}" Widgets)
for path in "${file_length_paths[@]}"; do
  mkdir -p "$fixture/$path"
  python3 - "$fixture/$path/LengthBoundary.swift" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_text("// File length boundary.\n" * 800)
PY
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  printf '// One line beyond the strict limit.\n' >> "$fixture/$path/LengthBoundary.swift"
done
if run_lint; then
  echo 'A file above 800 total lines passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  grep -F "$path/LengthBoundary.swift" "$test_root/lint.log" | grep -F '(file_length)' >/dev/null
  rm "$fixture/$path/LengthBoundary.swift"
done

# Function bodies share the same hard limit across production and test targets.
# Blank and comment-only lines do not consume the 100-line budget.
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path/FunctionLengthBoundary.swift" <<'PY'
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    "func lengthBoundary() {\n" + "  _ = 0\n\n  // Ignored by the body length rule.\n" * 100 + "}\n"
)
PY
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path/FunctionLengthBoundary.swift" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1])
source.write_text(source.read_text().removesuffix("}\n") + "  _ = 0\n}\n")
PY
done
if run_lint; then
  echo 'A function above 100 body lines passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  grep -F "$path/FunctionLengthBoundary.swift" "$test_root/lint.log" | grep -F '(function_body_length)' >/dev/null
  rm "$fixture/$path/FunctionLengthBoundary.swift"
done

# Type bodies share the same hard limit in every production and test target.
# Exercise every declaration kind checked by the upstream rule.
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path" <<'PY'
import sys
from pathlib import Path

for kind in ("class", "struct", "enum", "actor"):
    name = "TypeLengthBoundary" + kind.title()
    header = ("final " if kind == "class" else "") + kind + " " + name
    members = [
        (f"  case value{index}" if kind == "enum" else f"  let value{index} = 0")
        for index in range(500)
    ]
    Path(sys.argv[1], name + ".swift").write_text(
        header + " {\n\n  // Ignored by the body length rule.\n"
        + "\n".join(members) + "\n}\n"
    )
PY
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path" <<'PY'
import sys
from pathlib import Path

for kind in ("class", "struct", "enum", "actor"):
    source = Path(sys.argv[1], "TypeLengthBoundary" + kind.title() + ".swift")
    member = "  case value500" if kind == "enum" else "  let value500 = 0"
    source.write_text(source.read_text().removesuffix("}\n") + member + "\n}\n")
PY
done
if run_lint; then
  echo 'A type above 500 body lines passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  for kind in Class Struct Enum Actor; do
    grep -F "$path/TypeLengthBoundary$kind.swift" "$test_root/lint.log" | grep -F '(type_body_length)' >/dev/null
    rm "$fixture/$path/TypeLengthBoundary$kind.swift"
  done
done

# Complexity counts decisions in functions, initializers and switch dispatch.
# Verify both the hard threshold and the upstream switch-case policy.
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path/ComplexityBoundary.swift" <<'PY'
import sys
from pathlib import Path

decisions = "".join(f"  if value == {index} {{ _ = value }}\n" for index in range(20))
cases = "".join(f"  case {index}: return {index}\n" for index in range(19))
Path(sys.argv[1]).write_text(
    "func decisionBoundary(_ value: Int) {\n" + decisions + "}\n"
    + "final class DecisionBoundary {\n  init(_ value: Int) {\n" + decisions + "  }\n}\n"
    + "func switchBoundary(_ value: Int) -> Int {\n  switch value {\n"
    + cases + "  default: return -1\n  }\n}\n"
)
PY
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path/ComplexityBoundary.swift" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1])
source.write_text(
    source.read_text()
    .replace("  if value == 19 { _ = value }\n", "  if value == 19 { _ = value }\n  if value == 20 { _ = value }\n")
    .replace("  default: return -1", "  case 19: return 19\n  default: return -1")
)
PY
done
if run_lint; then
  echo 'A function, initializer or switch above complexity 20 passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  # Every fixture contains three independent declarations above the limit.
  findings=$(grep -F "$path/ComplexityBoundary.swift" "$test_root/lint.log" | grep -c '(cyclomatic_complexity)')
  if [[ "$findings" -ne 3 ]]; then
    cat "$test_root/lint.log" >&2
    echo "Expected three complexity failures in $path, found $findings." >&2
    exit 1
  fi
  rm "$fixture/$path/ComplexityBoundary.swift"
done

# Strict lint rejects a sixth required parameter, while default arguments are ignored.
for path in "${file_length_paths[@]}"; do
  cat > "$fixture/$path/ParameterCountBoundary.swift" <<'SWIFT'
func parameterBoundary(
  first: Int, second: Int, third: Int, fourth: Int, fifth: Int, sixth: Int = 0
) -> Int {
  first + second + third + fourth + fifth + sixth
}
SWIFT
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  python3 - "$fixture/$path/ParameterCountBoundary.swift" <<'PYTHON'
import sys
from pathlib import Path

source = Path(sys.argv[1])
source.write_text(source.read_text().replace("sixth: Int = 0", "sixth: Int"))
PYTHON
done
if run_lint; then
  echo 'A function with six required parameters passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  grep -F "$path/ParameterCountBoundary.swift" "$test_root/lint.log" | grep -F '(function_parameter_count)' >/dev/null
  rm "$fixture/$path/ParameterCountBoundary.swift"
done

# Strict lint accepts a two-member tuple type and rejects a third member.
for path in "${file_length_paths[@]}"; do
  cat > "$fixture/$path/TupleBoundary.swift" <<'SWIFT'
func tupleBoundary() -> (label: String, count: Int) {
  ("sample", 1)
}
SWIFT
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  cat > "$fixture/$path/TupleBoundary.swift" <<'SWIFT'
func tupleBoundary() -> (label: String, count: Int, enabled: Bool) {
  ("sample", 1, true)
}
SWIFT
done
if run_lint; then
  echo 'A three-member tuple type passed strict lint.' >&2
  exit 1
fi
for path in "${file_length_paths[@]}"; do
  grep -F "$path/TupleBoundary.swift" "$test_root/lint.log" | grep -F '(large_tuple)' >/dev/null
  rm "$fixture/$path/TupleBoundary.swift"
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
cat > "$fixture/Okou/GraphFactory.swift" <<'SWIFT'
import CCState
func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
let action = Command<Void, Void> { _ in let _ = makeRead(1) }
final class Owner {
  var read: Computed<Int> { Computed { _ in 1 } }
}
SWIFT
if run_lint; then
  echo 'Repeated graph factory calls and getter construction passed the configured lint entry point.' >&2
  exit 1
fi
grep -F 'GraphFactory.swift' "$test_root/lint.log" >/dev/null
grep -F 'okou_stable_graph' "$test_root/lint.log" >/dev/null
rm "$fixture/Okou/GraphFactory.swift"
cat > "$fixture/Okou/CollectionWrite.swift" <<'SWIFT'
import CCState
final class Owner {
  var items: [String] = []
  func reload() -> Task<Void, Never> {
    Task {
      await service.load()
      items.append("loaded")
    }
  }
}
SWIFT
if run_lint; then
  echo 'An owner collection mutation after await passed the configured lint entry point.' >&2
  exit 1
fi
grep -F 'okou_check_after_await' "$test_root/lint.log" >/dev/null
rm "$fixture/Okou/CollectionWrite.swift"
cat > "$fixture/Okou/ResourceCancellation.swift" <<'SWIFT'
import CCState
let read = computedTask { get, options in
  do { return try await service.load() }
  catch {
    let cause = error
    let cancelled = cause is CancellationError
    switch cancelled {
    case true: return []
    case false: throw error
    }
  }
}
SWIFT
if run_lint; then
  echo 'An aliased cancellation switch passed the configured lint entry point.' >&2
  exit 1
fi
grep -F 'ResourceCancellation.swift' "$test_root/lint.log" >/dev/null
grep -F 'okou_resource_failures' "$test_root/lint.log" >/dev/null
rm "$fixture/Okou/ResourceCancellation.swift"
for path in "${test_paths[@]}"; do
  printf 'var fixtureState = 0\n' >> "$fixture/$path/Fixture.swift"
done
if ! run_lint; then
  cat "$test_root/lint.log" >&2
  exit 1
fi

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
