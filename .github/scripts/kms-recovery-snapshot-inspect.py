#!/usr/bin/env python3
"""Inspect one isolated snapshot preview; never finalize, migrate, or retire KMS."""

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.parse

from kms_recovery_verify import (
    RecoveryVerificationError,
    target_session,
    verify_database,
)

PROJECT = "hidden-lab-39609750"
BASE = f"https://console.neon.tech/api/v2/projects/{PROJECT}"
WORKFLOW = (
    "vm0-ai/vm0/.github/workflows/kms-recovery-snapshot-inspect.yml@refs/heads/main"
)
PREFIX = "kms-recovery-32264-"
DEADLINE = time.monotonic() + 20 * 60


class InspectionError(Exception):
    """Only fixed codes, never provider or database text, reach reports."""


def require(condition, code):
    if not condition:
        raise InspectionError(code)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def timestamp(value):
    require(isinstance(value, str), "invalid_timestamp")
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "timestamp_timezone_missing")
    return result.astimezone(dt.timezone.utc)


def identifier(value, prefix=""):
    require(
        isinstance(value, str)
        and re.fullmatch(r"[a-z0-9-]{1,80}", value)
        and value.startswith(prefix),
        "invalid_resource_id",
    )
    return value


def api(suffix, method="GET", body=None, allow_missing=False):
    # Call sites provide all paths; no user-supplied URL or redirect is accepted.
    require(suffix.startswith("/"), "invalid_api_path")
    seconds = min(45, int(DEADLINE - time.monotonic()))
    require(seconds > 0, "inspection_time_budget_exhausted")
    command = [
        "curl",
        "--silent",
        "--show-error",
        "--max-time",
        str(seconds),
        "--max-filesize",
        "8388608",
        "--proto",
        "=https",
        "--request",
        method,
        "--header",
        "Authorization: Bearer " + os.environ["NEON_API_KEY"],
        "--header",
        "Content-Type: application/json",
        "--write-out",
        "\n%{http_code}",
    ]
    if body is not None:
        command.extend(["--data-binary", "@-"])
    command.append(BASE + suffix)
    response = subprocess.run(
        command,
        input=json.dumps(body) if body is not None else None,
        capture_output=True,
        text=True,
        timeout=seconds + 5,
    )
    require(response.returncode == 0, "neon_request_outcome_unconfirmed")
    content, status = response.stdout.rsplit("\n", 1)
    if allow_missing and status == "404":
        return None
    require(
        status in {"200", "201", "202"},
        "neon_http_" + status
        if re.fullmatch(r"\d{3}", status)
        else "invalid_neon_status",
    )
    data = json.loads(content)
    require(isinstance(data, dict), "invalid_neon_response")
    return data


def listing(collection, query=None):
    items, seen = [], set()
    query = dict(query or {})
    for _ in range(100):
        suffix = "/" + collection
        if query:
            suffix += "?" + urllib.parse.urlencode(query)
        data = api(suffix)
        page = data.get(collection)
        require(
            isinstance(page, list) and all(isinstance(x, dict) for x in page),
            "invalid_listing",
        )
        items.extend(page)
        require(len(items) <= 10000, "listing_limit")
        pagination = data.get("pagination", {})
        require(isinstance(pagination, dict), "invalid_pagination")
        next_cursor = pagination.get("next") or pagination.get("cursor")
        if not next_cursor:
            require(
                not pagination.get("has_more") and not data.get("has_more"),
                "incomplete_listing",
            )
            ids = [identifier(x.get("id")) for x in items]
            require(len(ids) == len(set(ids)), "duplicate_resource_id")
            return items
        require(
            collection == "branches"
            and isinstance(next_cursor, str)
            and next_cursor not in seen,
            "unsupported_pagination",
        )
        seen.add(next_cursor)
        query["cursor"] = next_cursor
    raise InspectionError("pagination_limit")


def wait_operations(data):
    operations = data.get("operations")
    require(isinstance(operations, list), "operations_missing")
    for operation in operations:
        operation_id = identifier(operation.get("id"))
        for _ in range(60):
            current = api(f"/operations/{operation_id}")["operation"]
            require(current.get("id") == operation_id, "operation_identity_mismatch")
            status = current.get("status")
            if status in {"finished", "skipped"}:
                break
            require(status in {"running", "scheduling"}, "neon_operation_failed")
            time.sleep(5)
        else:
            raise InspectionError("operation_wait_limit")


def branch_identity(branch):
    return {
        k: branch.get(k) for k in ("id", "project_id", "name", "default", "protected")
    }


def production_endpoints(branch_id):
    return sorted(
        [
            {k: endpoint.get(k) for k in ("id", "branch_id", "host", "type")}
            for endpoint in listing("endpoints")
            if endpoint.get("branch_id") == branch_id
        ],
        key=lambda x: x["id"],
    )


def snapshot_state(snapshots):
    return sorted(
        [
            {
                k: item.get(k)
                for k in (
                    "id",
                    "source_branch_id",
                    "created_at",
                    "expires_at",
                    "timestamp",
                    "lsn",
                    "manual",
                )
            }
            for item in snapshots
        ],
        key=lambda x: x["id"],
    )


def validate_preview(branch, name, snapshot_id, existing_ids):
    branch_id = identifier(branch.get("id"), "br-")
    require(branch_id not in existing_ids, "preview_is_existing_branch")
    require(
        branch.get("project_id") == PROJECT
        and branch.get("name") == name
        and branch.get("default") is False
        and branch.get("protected") is False
        and branch.get("restored_from") == snapshot_id
        and branch.get("restore_status") == "restored",
        "preview_identity_mismatch",
    )
    return branch_id


def inspect_database(database, endpoint, branch_id, target_environment=None):
    name, owner = database.get("name"), database.get("owner_name")
    require(database.get("branch_id") == branch_id, "database_branch_mismatch")
    require(
        all(
            isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,63}", x)
            for x in (name, owner)
        ),
        "invalid_database_identity",
    )
    query = urllib.parse.urlencode(
        {
            "branch_id": branch_id,
            "endpoint_id": endpoint["id"],
            "database_name": name,
            "role_name": owner,
            "pooled": "false",
        }
    )
    parsed = urllib.parse.urlsplit(api("/connection_uri?" + query)["uri"])
    require(
        parsed.scheme in {"postgres", "postgresql"}
        and parsed.hostname == endpoint["host"]
        and parsed.port in {None, 5432}
        and parsed.hostname.endswith(".neon.tech")
        and "-pooler" not in parsed.hostname
        and urllib.parse.unquote(parsed.path) == "/" + name
        and urllib.parse.unquote(parsed.username or "") == owner
        and parsed.password,
        "isolated_connection_identity_mismatch",
    )
    environment = {
        k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "LANG", "LC_ALL"}
    }
    environment.update(
        {
            "PGHOST": parsed.hostname,
            "PGPORT": "5432",
            "PGDATABASE": name,
            "PGUSER": owner,
            "PGPASSWORD": urllib.parse.unquote(parsed.password),
            "PGSSLMODE": "verify-full",
            "PGSSLROOTCERT": "/etc/ssl/certs/ca-certificates.crt",
            "PGCONNECT_TIMEOUT": "30",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=5000",
        }
    )
    seconds = min(900, int(DEADLINE - time.monotonic()))
    require(seconds > 0, "inspection_time_budget_exhausted")
    result = subprocess.run(
        [
            "psql",
            "-X",
            "-qAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            str(Path(__file__).with_name("kms-recovery-snapshot-inventory.sql")),
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=seconds,
    )
    require(result.returncode == 0, "snapshot_database_scan_failed")
    records = [json.loads(line) for line in result.stdout.splitlines() if line]
    headers = [r for r in records if r.get("kind") == "database"]
    require(
        len(headers) == 1
        and headers[0].get("readOnly") is True
        and headers[0].get("isolation") == "repeatable read",
        "read_only_transaction_unverified",
    )
    safe = []
    fields = {
        "database": {"largeObjects", "foreignTables"},
        "table": {
            "relationOid",
            "rows",
            "rowsWithEnvelopeMarker",
            "rowsWithSourceReference",
        },
        "binary": {"relationOid", "columnNumber", "nonNullValues"},
    }
    for record in records:
        kind = record.get("kind")
        require(kind in fields, "unknown_scan_record")
        item = {"kind": kind}
        for field in fields[kind]:
            value = record.get(field)
            require(type(value) is int and value >= 0, "invalid_scan_counter")
            item[field] = value
        safe.append(item)
    scanned = {"databaseNameSha256": digest(name), "readOnly": True, "records": safe}
    if target_environment is not None:
        scanned["targetVerification"] = verify_database(
            parsed, target_environment, DEADLINE
        )
    return scanned


def main():
    global DEADLINE
    report_path = Path(os.environ["RUNNER_TEMP"]) / "kms-recovery-snapshot.json"
    report = {
        "version": 1,
        "runId": os.environ.get("GITHUB_RUN_ID"),
        "attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "commit": os.environ.get("GITHUB_SHA"),
        "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "collectionComplete": False,
        "retirementCleared": False,
        "cryptographicVerification": False,
        "nestedPayloadInspection": False,
        "kmsCallsMade": False,
        "existingSnapshotsChanged": False,
        "productionDatabaseConnected": False,
        "restoreFinalized": False,
        "previewCreated": False,
        "cleanupComplete": False,
        "databases": [],
    }

    def checkpoint():
        report_path.write_text(json.dumps(report, indent=2) + "\n")

    preview_id = None
    production = None
    before_endpoints = None
    before_snapshots = None
    existing_ids = set()
    snapshot_id = None
    target_environment = None
    checkpoint()
    try:
        require(
            os.environ.get("GITHUB_REPOSITORY") == "vm0-ai/vm0"
            and os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and os.environ.get("GITHUB_WORKFLOW_REF") == WORKFLOW,
            "unprotected_invocation",
        )
        verification = os.environ.get("VERIFY_TARGET_CIPHERTEXT", "false")
        require(verification in {"true", "false"}, "invalid_target_verification_option")
        if verification == "true":
            DEADLINE = time.monotonic() + 90 * 60
        require(
            os.environ.get("NEON_PROJECT_ID") == PROJECT
            and os.environ.get("NEON_API_KEY"),
            "project_or_credential_missing",
        )
        require(
            re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")),
            "invalid_commit",
        )
        run_id = identifier(os.environ.get("GITHUB_RUN_ID"))
        attempt = identifier(os.environ.get("GITHUB_RUN_ATTEMPT"))
        require(run_id.isdigit() and attempt.isdigit(), "invalid_run_identity")
        name = PREFIX + run_id + "-" + attempt
        report["previewName"] = name
        expected_hash = os.environ.get("SNAPSHOT_SHA256", "")
        require(re.fullmatch(r"[0-9a-f]{64}", expected_hash), "invalid_snapshot_hash")
        created_at = timestamp(os.environ.get("EXPECTED_CREATED_AT"))
        branches = listing("branches")
        existing_ids = {branch["id"] for branch in branches}
        require(
            not any(branch.get("name", "").startswith(PREFIX) for branch in branches),
            "existing_inspection_preview_requires_review",
        )
        candidates = [b for b in branches if b.get("name") == "production"]
        require(
            len(candidates) == 1 and candidates[0].get("project_id") == PROJECT,
            "production_branch_not_unique",
        )
        production = branch_identity(candidates[0])
        before_endpoints = production_endpoints(production["id"])
        require(bool(before_endpoints), "production_endpoints_missing")
        snapshots = listing("snapshots")
        before_snapshots = snapshot_state(snapshots)
        candidates = [s for s in snapshots if digest(s["id"]) == expected_hash]
        require(len(candidates) == 1, "snapshot_not_unique")
        snapshot = candidates[0]
        require(
            snapshot.get("source_branch_id") == production["id"]
            and timestamp(snapshot.get("created_at")) == created_at,
            "snapshot_identity_mismatch",
        )
        snapshot_id = snapshot["id"]
        if verification == "true":
            target_environment, report["targetSession"] = target_session()
            checkpoint()
        report.update(
            {
                "snapshotIdSha256": expected_hash,
                "snapshotCreatedAt": created_at.isoformat(),
                "restoreRequestStarted": True,
            }
        )
        checkpoint()
        # The API creates a new branch. Never call finalize_restore or branch restore.
        restored = api(
            f"/snapshots/{snapshot_id}/restore",
            "POST",
            {"name": name, "finalize_restore": False},
        )
        candidate_id = validate_preview(
            restored["branch"], name, snapshot_id, existing_ids
        )
        preview_id = candidate_id
        report.update({"previewCreated": True, "previewBranchId": preview_id})
        checkpoint()
        wait_operations(restored)
        validate_preview(
            api(f"/branches/{preview_id}")["branch"], name, snapshot_id, existing_ids
        )
        # Discover only this preview's computes. The project-wide listing is not
        # an acknowledgement of a just-created endpoint; pin its returned ID.
        endpoints = api(f"/branches/{preview_id}/endpoints")["endpoints"]
        require(
            isinstance(endpoints, list)
            and all(
                isinstance(e, dict) and e.get("branch_id") == preview_id
                for e in endpoints
            ),
            "preview_endpoint_listing_mismatch",
        )
        report["previewEndpointCountBeforeCreate"] = len(endpoints)
        report["previewEndpointTypeCountsBeforeCreate"] = {
            kind: sum(e.get("type") == kind for e in endpoints)
            for kind in ("read_write", "read_only")
        }
        checkpoint()
        endpoint_ids = [identifier(e.get("id"), "ep-") for e in endpoints]
        require(
            len(endpoint_ids) == len(set(endpoint_ids)), "duplicate_preview_endpoint_id"
        )
        require(
            all(e.get("type") in {"read_write", "read_only"} for e in endpoints),
            "unknown_preview_endpoint_type",
        )
        # Snapshot restore can copy both the primary and read replicas. Pin the
        # unique primary; counting every compute incorrectly rejects that case.
        primaries = [e for e in endpoints if e["type"] == "read_write"]
        if not primaries:
            created = api(
                "/endpoints",
                "POST",
                {
                    "endpoint": {
                        "branch_id": preview_id,
                        "type": "read_write",
                        "autoscaling_limit_min_cu": 0.25,
                        "autoscaling_limit_max_cu": 0.25,
                        "suspend_timeout_seconds": 60,
                    }
                },
            )
            require(
                created["endpoint"].get("branch_id") == preview_id
                and created["endpoint"].get("type") == "read_write",
                "created_endpoint_branch_mismatch",
            )
            endpoint_id = identifier(created["endpoint"].get("id"), "ep-")
            require(
                endpoint_id not in {e["id"] for e in before_endpoints},
                "created_endpoint_is_existing",
            )
            report["createdPreviewEndpointId"] = endpoint_id
            checkpoint()
            wait_operations(created)
            primaries = [created["endpoint"]]
        require(len(primaries) == 1, "preview_primary_endpoint_not_unique")
        endpoint_id = identifier(primaries[0].get("id"), "ep-")
        endpoint = api(f"/endpoints/{endpoint_id}")["endpoint"]
        require(
            endpoint.get("id") == endpoint_id
            and endpoint.get("branch_id") == preview_id
            and endpoint.get("type") == "read_write"
            and isinstance(endpoint.get("host"), str)
            and endpoint["host"].startswith(endpoint["id"] + ".")
            and endpoint["host"].endswith(".neon.tech")
            and endpoint["id"] not in {e["id"] for e in before_endpoints},
            "preview_endpoint_identity_mismatch",
        )
        report["selectedPreviewEndpointId"] = endpoint_id
        report["selectedPreviewEndpointType"] = endpoint["type"]
        checkpoint()
        databases = api(f"/branches/{preview_id}/databases")["databases"]
        require(
            isinstance(databases, list)
            and 0 < len(databases) <= 20
            and len({d.get("name") for d in databases}) == len(databases),
            "invalid_database_listing",
        )
        for database in databases:
            if target_environment is not None:
                if report["kmsCallsMade"] is False:
                    report["kmsCallsMade"] = None
                report["targetVerificationStarted"] = True
                checkpoint()
            report["databases"].append(
                inspect_database(database, endpoint, preview_id, target_environment)
            )
            if target_environment is not None:
                report["kmsCallsMade"] = any(
                    item["targetVerification"]["totals"]["verified"] > 0
                    for item in report["databases"]
                )
            checkpoint()
        if target_environment is not None:
            report["cryptographicVerification"] = True
            report["nestedPayloadInspection"] = True
        report["collectionComplete"] = True
    except (
        InspectionError,
        RecoveryVerificationError,
        KeyError,
        ValueError,
        TypeError,
        OSError,
        subprocess.TimeoutExpired,
    ) as error:
        report["failure"] = (
            str(error)
            if isinstance(error, (InspectionError, RecoveryVerificationError))
            else "inspection_failed"
        )
    finally:
        # Reserve cleanup and preservation read-back time inside the job budget.
        DEADLINE = time.monotonic() + 5 * 60
        if preview_id is not None:
            try:
                validate_preview(
                    api(f"/branches/{preview_id}")["branch"],
                    name,
                    snapshot_id,
                    existing_ids,
                )
                wait_operations(api(f"/branches/{preview_id}", "DELETE"))
                require(
                    api(f"/branches/{preview_id}", allow_missing=True) is None,
                    "preview_still_live",
                )
                report["cleanupComplete"] = True
                # Deletion can leave a recoverable copy. Never equate DELETE with
                # permanent removal of the restored historical ciphertext.
                report["deletedPreviewRecoveryVerified"] = False
                try:
                    deleted = [
                        b
                        for b in listing("branches", {"include_deleted": "true"})
                        if b["id"] == preview_id
                    ]
                    report["deletedPreviewRecoveryVerified"] = True
                    report["deletedPreviewStillListed"] = bool(deleted)
                    if deleted:
                        recovery = deleted[0].get("recovery") or {}
                        until = recovery.get("recoverable_until")
                        report["deletedPreviewRecoverableUntil"] = (
                            timestamp(until).isoformat() if until else None
                        )
                except (
                    InspectionError,
                    KeyError,
                    ValueError,
                    TypeError,
                    OSError,
                    subprocess.TimeoutExpired,
                ):
                    report["deletedPreviewRecoveryFailure"] = (
                        "recovery_metadata_unavailable"
                    )
            except (
                InspectionError,
                KeyError,
                ValueError,
                TypeError,
                OSError,
                subprocess.TimeoutExpired,
            ):
                report["cleanupFailure"] = "preview_cleanup_unconfirmed"
        if production is not None:
            DEADLINE = time.monotonic() + 2 * 60
            try:
                report["productionBranchUnchanged"] = (
                    branch_identity(api(f"/branches/{production['id']}")["branch"])
                    == production
                )
                report["productionEndpointsUnchanged"] = (
                    before_endpoints is not None
                    and production_endpoints(production["id"]) == before_endpoints
                )
                report["snapshotSetUnchanged"] = (
                    before_snapshots is not None
                    and snapshot_state(listing("snapshots")) == before_snapshots
                )
            except (
                InspectionError,
                KeyError,
                ValueError,
                TypeError,
                OSError,
                subprocess.TimeoutExpired,
            ):
                report["preservationReadbackFailure"] = (
                    "preservation_readback_unconfirmed"
                )
        report["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        report["result"] = (
            "collected"
            if report["collectionComplete"]
            and report["cleanupComplete"]
            and all(
                report.get(k) is True
                for k in (
                    "productionBranchUnchanged",
                    "productionEndpointsUnchanged",
                    "snapshotSetUnchanged",
                )
            )
            else "incomplete"
        )
        checkpoint()
    print("Snapshot inspection " + report["result"] + "; sanitized report retained.")
    return 0 if report["result"] == "collected" else 1


if __name__ == "__main__":
    raise SystemExit(main())
