"""Bounded, credential-free observations published by the registry's state owner.

The control thread only reads a completed projection. It never loads files or
holds this lock while compilation, catalog reads, or auth reconciliation run.
"""

from __future__ import annotations

import ipaddress
import threading
from typing import TYPE_CHECKING

import state_file

if TYPE_CHECKING:
    import registry

MAX_ENTRY_OUTCOMES = 32
_lock = threading.Lock()
_last_state: registry.RegistryState | None = None
_status: dict[str, object] = {"state": "unobserved"}


def reset() -> None:
    global _last_state, _status
    with _lock:
        _last_state = None
        _status = {"state": "unobserved"}


def snapshot() -> dict[str, object]:
    """Return an immutable-by-ownership projection, not a fresh file check."""
    with _lock:
        return _status


def file_identity(key: state_file.StateFileIdentity | None) -> dict[str, int] | None:
    if key is None:
        return None
    return {
        "device": key.st_dev,
        "inode": key.st_ino,
        "mtimeNs": key.st_mtime_ns,
        "size": key.st_size,
    }


def _source_ip(value: str) -> str | None:
    # Invalid registry keys must not become an arbitrary-string disclosure path.
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.scope_id is not None:
        return None
    return str(address)


def publish_unavailable(state: registry.RegistryUnavailable) -> None:
    global _last_state, _status
    if state is _last_state:
        return
    result: dict[str, object] = {
        "state": "unavailable",
        "digest": state.digest,
        "file": file_identity(state.loaded_key),
        "reason": state.reason,
    }
    with _lock:
        _last_state = state
        _status = result


def publish_available(state: registry._RegistrySnapshot) -> None:
    """Called only by the main-loop registry owner after a complete load result."""
    global _last_state, _status
    if state is _last_state:
        return
    result: dict[str, object] = {
        "digest": state.digest,
        "file": file_identity(state.loaded_key),
    }
    catalog = state.builtin_firewall_catalog_snapshot
    dependency: dict[str, object]
    if catalog is None:
        dependency = {"state": "not_used"}
    elif catalog.catalog is None:
        dependency = {
            "state": "unavailable",
            "file": file_identity(catalog.dependency_file_key),
            "reason": catalog.unavailable_reason,
        }
    else:
        dependency = {
            "state": "available",
            "file": file_identity(catalog.dependency_file_key),
            "digest": catalog.catalog.identity.catalog_digest.removeprefix("sha256:"),
        }
    entries: list[dict[str, object]] = []
    # Rejected and omitted entries are useful diagnostics; ordinary valid
    # entries contribute counts without crowding out actionable outcomes.
    for source_ip, invalid in state.invalid_sandboxes.items():
        if len(entries) == MAX_ENTRY_OUTCOMES:
            break
        entries.append({"sourceIp": _source_ip(source_ip), "reason": invalid.reason})
    omitted_ips = state.omitted_builtin_firewalls.keys() | state.omitted_custom_connector_ids.keys()
    for source_ip in omitted_ips:
        if len(entries) == MAX_ENTRY_OUTCOMES:
            break
        entries.append(
            {
                "sourceIp": _source_ip(source_ip),
                "reason": "omitted_intents",
                "builtinCount": len(state.omitted_builtin_firewalls.get(source_ip, ())),
                "customCount": len(state.omitted_custom_connector_ids.get(source_ip, ())),
            }
        )
    result.update(
        state="available",
        catalog=dependency,
        validEntries=len(state.sandboxes),
        rejectedEntries=len(state.invalid_sandboxes),
        omittedEntries=len(omitted_ips),
        entries=entries,
        truncated=len(state.invalid_sandboxes) + len(omitted_ips) > len(entries),
    )
    with _lock:
        _last_state = state
        _status = result
