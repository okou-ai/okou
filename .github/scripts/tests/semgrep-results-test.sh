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

python3 - "$results_script" "$test_dir" <<'PY'
import copy
import json
from pathlib import Path
import subprocess
import sys

script = Path(sys.argv[1])
root = Path(sys.argv[2]) / "android-policy"
root.mkdir()
manifest = root / "android/app/src/main/AndroidManifest.xml"
manifest.parent.mkdir(parents=True)
source = '''<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        <activity android:name=".PrivateActivity" android:exported="false" />
    </application>
</manifest>
'''
manifest.write_text(source)
(root / "baseline.json").write_text("{}")
rule = "java.android.security.exported_activity.exported_activity"
finding = {
    "check_id": rule,
    "path": "android/app/src/main/AndroidManifest.xml",
    "start": {"line": 3},
    "end": {"line": 8},
}
sarif_finding = {
    "ruleId": rule,
    "locations": [{"physicalLocation": {
        "artifactLocation": {"uri": finding["path"]},
        "region": {"startLine": 3, "endLine": 8},
    }}],
}


def run(*args, success=True):
    result = subprocess.run(
        ["python3", str(script), *args], cwd=root, text=True, capture_output=True
    )
    assert (result.returncode == 0) == success, result.stdout + result.stderr


def check(findings, success=True):
    (root / "results.json").write_text(json.dumps({"results": findings}))
    for mode in ("diff", "full"):
        run("check", mode, "baseline.json", "results.json", success=success)


check([finding])
manifest.write_text('<!-- <activity android:name=".MainActivity" android:exported="true" /> -->\n' + source)
check([dict(finding, start={"line": 4}, end={"line": 9})])
manifest.write_text(source)
for changed in (
    dict(finding, check_id="other.security.rule"),
    dict(finding, path="other/AndroidManifest.xml"),
    dict(finding, start={"line": 9}, end={"line": 9}),
    dict(finding, start={}),
):
    check([changed], success=False)

# Both report formats must preserve unrelated findings, even in the same file.
outside = copy.deepcopy(sarif_finding)
outside["locations"][0]["physicalLocation"]["region"] = {"startLine": 9, "endLine": 9}
unrelated = {"ruleId": "other.security.rule", "message": {"text": "unreviewed"}}
for mode in ("diff", "full"):
    (root / "input.sarif").write_text(json.dumps({"runs": [{
        "results": [sarif_finding, outside, unrelated],
    }]}))
    run("filter", mode, "baseline.json", "input.sarif", "filtered.sarif")
    filtered = json.loads((root / "filtered.sarif").read_text())
    assert filtered["runs"][0]["results"] == [outside, unrelated]

mutations = (
    source.replace('android:exported="false"', 'android:exported="true"'),
    source.replace('<activity android:name=".PrivateActivity"', '<activity-alias android:name=".PrivateActivity"').replace('android:exported="false"', 'android:exported="true"'),
    source.replace('<activity android:name=".PrivateActivity"', '<receiver android:name=".PrivateReceiver"').replace('android:exported="false"', 'android:exported="true"'),
    source.replace('android:exported="true"', ''),
    source.replace('.MainActivity', '.UnreviewedActivity'),
    source.replace('            </intent-filter>', '                <data android:scheme="okou" />\n            </intent-filter>'),
    source.replace('            </intent-filter>', '            </intent-filter>\n            <intent-filter><action android:name="android.intent.action.VIEW" /></intent-filter>'),
    source.replace('android.intent.category.LAUNCHER', 'android.intent.category.BROWSABLE'),
)
for changed_source in mutations:
    manifest.write_text(changed_source)
    # The manifest guard fails even when Semgrep reports no finding.
    check([], success=False)
manifest.write_text(source)
overlay = root / "android/app/src/debug/AndroidManifest.xml"
overlay.parent.mkdir(parents=True)
overlay.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><service android:name=".PublicService" android:exported="true" /></application></manifest>')
check([], success=False)
overlay.unlink()
check([finding])
manifest.unlink()
check([], success=False)
manifest.write_text(source)
print("Android launcher audit: reviewed entry accepted; new components/routes/findings refused")
PY

echo "semgrep-results tests passed"
