#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/release/publish-okou-app-assets.sh"
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
assets_directory="${test_root}/assets"
fake_bin="${test_root}/bin"
object_store="${test_root}/objects"
aws_log="${test_root}/aws.log"
mkdir -p \
  "$assets_directory/nested" \
  "$fake_bin" \
  "$object_store/okou-app/assets"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

assert_put() {
  local key=$1 content_type=$2
  grep -Fqx \
    "put-object|https://test.r2.example|test-bucket|${key}|${content_type}|public, max-age=31536000, immutable|*" \
    "$aws_log" || fail "missing conditional upload for ${key}"
}

printf 'javascript\n' > "${assets_directory}/app-AbCd1234.js"
printf 'css\n' > "${assets_directory}/style-EfGh5678.css"
printf '{}\n' > "${assets_directory}/data-IjKl9012.json"
printf 'font\n' > "${assets_directory}/font-MnOp3456.woff2"
printf '{}\n' > "${assets_directory}/app-AbCd1234.js.map"
printf 'svg\n' > "${assets_directory}/nested/logo-Qrst7890.svg"
printf 'existing source\n' > "${assets_directory}/existing-UvWx1234.js"
printf 'race source\n' > "${assets_directory}/race-Yzab5678.js"
printf '{}\n' > "${assets_directory}/runtime.js.map"

printf 'retained existing bytes\n' \
  > "${object_store}/okou-app/assets/existing-UvWx1234.js"

cat > "${fake_bin}/aws" <<'BASH'
#!/usr/bin/env bash
set -euo pipefail

[[ "$1" == "s3api" ]] || exit 2
operation=$2
shift 2
endpoint=""
bucket=""
key=""
prefix=""
body=""
content_type=""
cache_control=""
if_none_match=""
while (( $# > 0 )); do
  case "$1" in
    --endpoint-url) endpoint=$2; shift 2 ;;
    --bucket) bucket=$2; shift 2 ;;
    --key) key=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --body) body=$2; shift 2 ;;
    --content-type) content_type=$2; shift 2 ;;
    --cache-control) cache_control=$2; shift 2 ;;
    --if-none-match) if_none_match=$2; shift 2 ;;
    --output) shift 2 ;;
    --no-cli-pager) shift ;;
    *) echo "unexpected aws argument: $1" >&2; exit 2 ;;
  esac
done

printf '%s|%s|%s|%s|%s|%s|%s\n' \
  "$operation" \
  "$endpoint" \
  "$bucket" \
  "$key" \
  "$content_type" \
  "$cache_control" \
  "$if_none_match" >> "$MOCK_AWS_LOG"

object_path="${MOCK_OBJECT_STORE}/${key}"
case "$operation" in
  list-objects-v2)
    [[ "$prefix" == 'okou-app/assets/' ]] || exit 2
    printf '{"Contents":[{"Key":"okou-app/assets/existing-UvWx1234.js"}]}\n'
    ;;
  put-object)
    if [[ "$key" == 'okou-app/assets/race-Yzab5678.js' ]]; then
      printf 'concurrent writer bytes\n' > "$object_path"
      echo 'An error occurred (PreconditionFailed) when calling the PutObject operation: 412' >&2
      exit 254
    fi
    if [[ -f "$object_path" ]]; then
      echo 'An error occurred (PreconditionFailed) when calling the PutObject operation: 412' >&2
      exit 254
    fi
    mkdir -p "$(dirname "$object_path")"
    cp "$body" "$object_path"
    printf '{}\n'
    ;;
  *) exit 2 ;;
esac
BASH
chmod +x "${fake_bin}/aws"

: > "$aws_log"
output="$({
  PATH="${fake_bin}:$PATH" \
    MOCK_AWS_LOG="$aws_log" \
    MOCK_OBJECT_STORE="$object_store" \
    bash "$script" \
      https://test.r2.example \
      test-bucket \
      "$assets_directory"
} 2>&1)"

grep -Fq 'Skipping unhashed source map: runtime.js.map' <<< "$output" ||
  fail "unhashed source map was not reported as skipped"
grep -Fq 'App asset already exists: okou-app/assets/existing-UvWx1234.js' <<< "$output" ||
  fail "existing object was not reported"
grep -Fq 'App asset already exists: okou-app/assets/race-Yzab5678.js' <<< "$output" ||
  fail "conditional write race was not treated as an existing object"
grep -Fq 'App asset publication complete' <<< "$output" ||
  fail "publication did not complete"

if [[ "$(grep -Fc 'list-objects-v2|' "$aws_log")" -ne 1 ]]; then
  fail "existing assets were not listed exactly once"
fi
if grep -Fq 'head-object|' "$aws_log"; then
  fail "an asset used a redundant HEAD request"
fi

assert_put 'okou-app/assets/app-AbCd1234.js' 'application/javascript'
assert_put 'okou-app/assets/style-EfGh5678.css' 'text/css; charset=utf-8'
assert_put 'okou-app/assets/data-IjKl9012.json' 'application/json'
assert_put 'okou-app/assets/font-MnOp3456.woff2' 'font/woff2'
assert_put 'okou-app/assets/app-AbCd1234.js.map' 'application/json'
assert_put 'okou-app/assets/nested/logo-Qrst7890.svg' 'image/svg+xml'
assert_put 'okou-app/assets/race-Yzab5678.js' 'application/javascript'

if grep -Fq 'runtime.js.map' "$aws_log"; then
  fail "unhashed source map reached R2"
fi
if grep -Fq 'put-object|https://test.r2.example|test-bucket|okou-app/assets/existing-UvWx1234.js' "$aws_log"; then
  fail "existing object was uploaded again"
fi
grep -Fqx 'retained existing bytes' \
  "${object_store}/okou-app/assets/existing-UvWx1234.js" ||
  fail "existing object was modified"
grep -Fqx 'concurrent writer bytes' \
  "${object_store}/okou-app/assets/race-Yzab5678.js" ||
  fail "conditional upload replaced the concurrent writer"
cmp -s \
  "${assets_directory}/app-AbCd1234.js.map" \
  "${object_store}/okou-app/assets/app-AbCd1234.js.map" ||
  fail "hashed source map was not published"

echo "publish okou app assets tests passed"
