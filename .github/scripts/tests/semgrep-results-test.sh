#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
results_script="$script_dir/checks/semgrep-results.py"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT

cat > "$test_dir/baseline.json" <<'EOF'
{
  "existing.rule": 1
}
EOF

cat > "$test_dir/within-baseline.json" <<'EOF'
{
  "results": [
    {"check_id": "existing.rule"}
  ]
}
EOF

cat > "$test_dir/regression.json" <<'EOF'
{
  "results": [
    {"check_id": "existing.rule"},
    {"check_id": "existing.rule"}
  ]
}
EOF

cat > "$test_dir/empty.json" <<'EOF'
{
  "results": []
}
EOF

cat > "$test_dir/new-finding.json" <<'EOF'
{
  "results": [
    {"check_id": "new.rule"}
  ]
}
EOF

cat > "$test_dir/results.sarif" <<'EOF'
{
  "version": "2.1.0",
  "runs": [
    {
      "results": [
        {"ruleId": "existing.rule", "message": {"text": "baseline"}},
        {"ruleId": "existing.rule", "message": {"text": "regression"}},
        {"ruleId": "new.rule", "message": {"text": "new"}}
      ]
    }
  ]
}
EOF

python3 "$results_script" \
  check full "$test_dir/baseline.json" "$test_dir/within-baseline.json"

if python3 "$results_script" \
  check full "$test_dir/baseline.json" "$test_dir/regression.json"; then
  echo "full scans must fail when a rule exceeds its baseline" >&2
  exit 1
fi

python3 "$results_script" \
  check diff "$test_dir/baseline.json" "$test_dir/empty.json"

if python3 "$results_script" \
  check diff "$test_dir/baseline.json" "$test_dir/new-finding.json"; then
  echo "diff scans must fail on every returned finding" >&2
  exit 1
fi

python3 "$results_script" \
  filter full \
  "$test_dir/baseline.json" \
  "$test_dir/results.sarif" \
  "$test_dir/full-filtered.sarif"

jq -e '
  [.runs[].results[].message.text] == ["regression", "new"]
' "$test_dir/full-filtered.sarif" > /dev/null

python3 "$results_script" \
  filter diff \
  "$test_dir/baseline.json" \
  "$test_dir/results.sarif" \
  "$test_dir/diff-filtered.sarif"

jq -e '
  [.runs[].results[].message.text] == ["baseline", "regression", "new"]
' "$test_dir/diff-filtered.sarif" > /dev/null

echo "semgrep-results tests passed"
