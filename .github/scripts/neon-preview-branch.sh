#!/usr/bin/env bash
# Prepares a Neon preview database branch through the Neon API and prints its
# pooled connection string on stdout. Progress and per-request timing go to
# stderr.
#
# Usage:
#   neon-preview-branch.sh branch <branch-name>  reset or create the branch
#   neon-preview-branch.sh parent                the project's default branch
#
# Requires NEON_API_KEY and NEON_PROJECT_ID.
set -euo pipefail

NEON_API_BASE="${NEON_API_BASE:-https://console.neon.tech/api/v2}"
DATABASE_NAME="neondb"
ROLE_NAME="neondb_owner"

for name in NEON_API_KEY NEON_PROJECT_ID; do
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
done

now_ms() {
  date +%s%3N
}

# neon_api <method> <path> [json-body]
# Prints the response body; logs the method, path, outcome, and duration.
neon_api() {
  local method=$1 path=$2 data=${3:-}
  local args=(
    -sS --fail-with-body -X "$method"
    -H "Authorization: Bearer ${NEON_API_KEY}"
    -H "Accept: application/json"
  )
  if [ -n "$data" ]; then
    args+=(-H "Content-Type: application/json" --data "$data")
  fi

  local started body status=0
  started=$(now_ms)
  body=$(curl "${args[@]}" "${NEON_API_BASE}/projects/${NEON_PROJECT_ID}${path}") || status=$?
  echo "[neon] ${method} ${path%%\?*} exit=${status} duration_ms=$(( $(now_ms) - started ))" >&2
  if [ "$status" -ne 0 ]; then
    # Error bodies carry Neon's message; success bodies may carry credentials.
    echo "$body" >&2
    return "$status"
  fi
  printf '%s' "$body"
}

# connection_string [branch-id]
# Without a branch id, Neon answers for the project's default branch.
connection_string() {
  local query="database_name=${DATABASE_NAME}&role_name=${ROLE_NAME}&pooled=true"
  if [ -n "${1:-}" ]; then
    query="branch_id=${1}&${query}"
  fi
  neon_api GET "/connection_uri?${query}" |
    jq -r '.uri' |
    node -e '
      const url = new URL(require("fs").readFileSync(0, "utf8").trim());
      url.searchParams.set("sslmode", "verify-full");
      url.searchParams.set("channel_binding", "require");
      process.stdout.write(url.toString());
    '
}

prepare_branch() {
  local branch_name=$1 branch_id state

  branch_id=$(
    neon_api GET "/branches?search=$(jq -rn --arg v "$branch_name" '$v | @uri')" |
      jq -r --arg name "$branch_name" '.branches[] | select(.name == $name) | .id'
  )

  if [ -n "$branch_id" ]; then
    local parent_id
    parent_id=$(neon_api GET "/branches/${branch_id}" | jq -r '.branch.parent_id')
    echo "Resetting ${branch_name} (${branch_id}) to its parent ${parent_id}" >&2
    neon_api POST "/branches/${branch_id}/restore" \
      "$(jq -cn --arg parent "$parent_id" '{source_branch_id: $parent}')" > /dev/null

    for attempt in {1..30}; do
      state=$(neon_api GET "/branches/${branch_id}" | jq -r '.branch.current_state')
      [ "$state" = "ready" ] && break
      echo "Branch state: ${state} (attempt ${attempt}/30)" >&2
      sleep 2
    done
  else
    echo "Creating ${branch_name}" >&2
    # The API creates no compute unless one is requested.
    branch_id=$(
      neon_api POST "/branches" \
        "$(jq -cn --arg name "$branch_name" '{branch: {name: $name}, endpoints: [{type: "read_write"}]}')" |
        jq -r '.branch.id'
    )
  fi

  connection_string "$branch_id"
}

started=$(now_ms)
case "${1:-}" in
  branch)
    if [ -z "${2:-}" ]; then
      echo "usage: $0 branch <branch-name>" >&2
      exit 2
    fi
    prepare_branch "$2"
    ;;
  parent)
    connection_string
    ;;
  *)
    echo "usage: $0 branch <branch-name> | parent" >&2
    exit 2
    ;;
esac
echo "[neon] total duration_ms=$(( $(now_ms) - started ))" >&2
