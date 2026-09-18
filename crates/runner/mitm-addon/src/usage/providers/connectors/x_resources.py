"""Bounded, transient identities for the configured X daily resource protocol."""

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ...buffer.models import ResourceUsageItem, ResourceUsageRemainder, UsageEvent

IDENTITY_BODY_LIMIT = 256 * 1024
MAX_RESOURCE_IDS = 1000
_ID = re.compile(r"[0-9]{1,32}")
_POST_PATH = re.compile(
    r"/2/(?:tweets(?:/[0-9]+|/search/(?:recent|all|stream)|/sample(?:10)?/stream)?"
    r"|users/[0-9]+/(?:tweets|mentions|liked_tweets|bookmarks|timelines/reverse_chronological))"
)
_USER_PATH = re.compile(r"/2/users(?:/[0-9]+|/me|/by|/by/username/[^/]+|/search)?")


def observed_at() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class _IdentityGroup:
    ids: dict[str, int] = field(default_factory=dict)
    overflow: int = 0


def inspect_identities(
    body: bytes | None, *, ndjson: bool = False
) -> dict[str, _IdentityGroup] | None:
    """Inspect only a previously validated document; oversized copies stay count-priced."""
    if body is None or len(body) > IDENTITY_BODY_LIMIT:
        return None
    try:
        document = json.loads(body)
    except (ValueError, RecursionError):
        # The selective validator can skip a huge unselected number that the
        # stdlib refuses to materialize. Counts still own accounting.
        return None
    if not isinstance(document, dict):
        return {}
    data = document.get("data")
    includes = document.get("includes")
    values = {
        "data": [data] if isinstance(data, dict) else ([] if ndjson else data),
        "tweets": includes.get("tweets") if isinstance(includes, dict) else None,
        "users": includes.get("users") if isinstance(includes, dict) else None,
    }
    groups: dict[str, _IdentityGroup] = {}
    for key, objects in values.items():
        group = _IdentityGroup()
        groups[key] = group
        if not isinstance(objects, list):
            continue
        for obj in objects:
            resource_id = obj.get("id") if isinstance(obj, dict) else None
            if not isinstance(resource_id, str) or _ID.fullmatch(resource_id) is None:
                continue
            if resource_id in group.ids:
                group.ids[resource_id] += 1
            elif len(group.ids) < MAX_RESOURCE_IDS:
                group.ids[resource_id] = 1
            else:
                group.overflow += 1
    return groups


def resource_event(
    event: UsageEvent,
    response: dict,
    *,
    endpoint_bucket: str,
    path: str,
    observation_time: str,
    count_endpoint: bool,
) -> UsageEvent:
    """Preserve Q = identified occurrences + explicit unidentified remainder."""
    category = event["category"]
    includes = {} if count_endpoint else response.get("response_includes") or {}
    primary_supported = category == endpoint_bucket and (
        (category == "posts.read" and _POST_PATH.fullmatch(path) is not None)
        or (category == "user.read" and _USER_PATH.fullmatch(path) is not None)
    )
    expansion = "tweets" if category == "posts.read" else "users"
    groups = [] if count_endpoint else [expansion]
    supported_quantity = includes.get(expansion, 0)
    if primary_supported:
        groups.append("data")
        supported_quantity += max(
            response.get("response_data_count") or 0,
            response.get("response_result_count") or 0,
        )
    reasons: dict[str, int] = {}
    ids: dict[str, int] = {}
    identities = response.get("resource_identities")
    if not response.get("body_parsed"):
        reasons["parse_fallback"] = event["quantity"]
    else:
        reasons["unsupported_resource"] = event["quantity"] - supported_quantity
        if identities is None:
            reasons["identity_limit"] = supported_quantity
        else:
            overflow = 0
            for key in groups:
                group = identities.get(key)
                if group is None:
                    continue
                overflow += group.overflow
                for resource_id, count in group.ids.items():
                    if resource_id in ids:
                        ids[resource_id] += count
                    elif len(ids) < MAX_RESOURCE_IDS:
                        ids[resource_id] = count
                    else:
                        overflow += count
            reasons["identity_limit"] = overflow
            reasons["missing_id"] = supported_quantity - sum(ids.values()) - overflow
    resources: list[ResourceUsageItem] = [
        {"id": resource_id, "occurrences": count} for resource_id, count in ids.items()
    ]
    remainder: list[ResourceUsageRemainder] = []
    for reason in ("missing_id", "unsupported_resource", "identity_limit", "parse_fallback"):
        quantity = reasons.get(reason, 0)
        if quantity < 0:
            raise ValueError("X resource occurrences exceed authoritative response count")
        if quantity:
            remainder.append({"reason": reason, "quantity": quantity})
    observation: UsageEvent = {
        **event,
        "protocol": "x-resource-v1",
        "observedAt": observation_time,
        "resources": resources,
        "remainder": remainder,
    }
    return observation
