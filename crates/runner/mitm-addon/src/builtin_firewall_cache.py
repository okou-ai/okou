"""Runner-written builtin firewall catalog cache reader."""

import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NamedTuple

from mitmproxy import ctx

import addon_process_logging
import builtin_firewall_catalog_validation as catalog_validation
import state_file
from builtin_firewall_catalog_validation import (
    BuiltinFirewallCatalogCacheError as BuiltinFirewallCatalogCacheError,
)
from generated.builtin_firewall_cache import BUILTIN_FIREWALL_CATALOG_MAX_BYTES

_UNTRUSTED_WRITE_BITS = stat.S_IWGRP | stat.S_IWOTH


CatalogFileKey = state_file.StateFileIdentity


class CatalogIdentity(NamedTuple):
    """Validated catalog source identity used by compiled firewall cache keys.

    Tuple order is `source`, `catalog_digest`, `catalog_version`, then
    `file_key`. The source is `cache`, and `file_key` identifies the exact file
    from which the validated catalog was loaded.
    """

    source: Literal["cache"]
    catalog_digest: str
    catalog_version: str
    file_key: CatalogFileKey


CatalogUnavailableReason = Literal[
    "cache_path_missing",
    "cache_file_missing",
    "cache_permission_denied",
    "cache_not_regular",
    "cache_untrusted",
    "cache_unavailable",
    "cache_invalid",
]


class _CatalogCacheOpenError(OSError):
    reason: CatalogUnavailableReason

    def __init__(self, reason: CatalogUnavailableReason, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class BuiltinFirewallCatalog:
    """Validated firewall map bound to the catalog cache file that supplied it.

    `identity` records the cache source, declared digest and version, and exact
    opened file key. `firewalls` is the validated catalog payload used for
    builtin firewall resolution.
    """

    identity: CatalogIdentity
    firewalls: dict[str, dict]


@dataclass(frozen=True)
class BuiltinFirewallCatalogSnapshot:
    """Result of loading one catalog cache dependency for a consumer pass.

    Loader-produced states are:

    - Success has `dependency_file_key`, `catalog`, and `cache_path`, with no
      `unavailable_reason`.
    - Missing path configuration has no dependency, catalog, or cache path and
      uses `cache_path_missing`.
    - Open or trust failure has no dependency or catalog, retains the absolute
      cache path, and uses the corresponding open-failure reason.
    - Read, size, decode, schema, or validation failure has the opened file key
      and absolute cache path, no catalog, and uses `cache_invalid`.

    `dependency_file_key` comes from the descriptor actually opened for this
    snapshot, not a preliminary path stat. `reuse_by_identity` is true only for
    success or deterministic size/decode/schema/validation rejection. I/O and
    open/trust failures must be retried even if the identity is unchanged.
    Both the loader and dependent registry snapshots use `can_reuse()` for
    identity-only reuse; the diagnostic reason alone does not establish it.
    After a fresh load, the registry may retain already-rejected enforcement
    when the complete unavailable snapshot is unchanged. This never skips a
    retryable catalog probe.
    """

    dependency_file_key: CatalogFileKey | None
    catalog: BuiltinFirewallCatalog | None
    cache_path: str | None = None
    unavailable_reason: CatalogUnavailableReason | None = None
    reuse_by_identity: bool = False

    def can_reuse(self, file_key: CatalogFileKey | None) -> bool:
        """Whether this result remains valid for the supplied file identity."""
        return (
            self.reuse_by_identity
            and self.dependency_file_key is not None
            and self.dependency_file_key == file_key
        )


@dataclass
class _CatalogCacheState:
    path_key: str | None = None
    snapshot: BuiltinFirewallCatalogSnapshot | None = None
    # Retry unchanged read failures, suppressing only their duplicate warnings.
    read_error_key: CatalogFileKey | None = None

    def reset(self, path_key: str | None = None) -> None:
        self.path_key = path_key
        self.snapshot = None
        self.read_error_key = None


_cache_state = _CatalogCacheState()


def reset_cache_for_tests() -> None:
    """Reset builtin firewall catalog cache state between tests."""
    clear_cache()


def clear_cache() -> None:
    """Drop the in-process builtin firewall catalog cache."""
    _cache_state.reset()


def configured_catalog_cache_path() -> str | None:
    """Return the runner-configured builtin catalog cache path."""
    options = getattr(ctx, "options", None)
    cache_path = getattr(options, "okou_builtin_firewall_catalog_cache_path", None)
    if not isinstance(cache_path, str) or cache_path == "":
        return None
    return cache_path


def load_configured_catalog_snapshot() -> BuiltinFirewallCatalogSnapshot:
    """Load the current runner-configured builtin catalog snapshot."""
    return load_catalog_snapshot(configured_catalog_cache_path())


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _CatalogCacheState:
    if _cache_state.path_key != path_key:
        _cache_state.reset(path_key)
    return _cache_state


def catalog_file_key(cache_path: str | None) -> CatalogFileKey | None:
    """Return current cache file identity for registry snapshot invalidation."""
    if not cache_path:
        return None
    path = Path(cache_path)
    try:
        st = path.stat(follow_symlinks=False)
    except OSError:
        return None
    if not _cache_file_stat_is_trusted(st):
        return None
    return CatalogFileKey(
        absolute_path=_path_key(path),
        st_dev=st.st_dev,
        st_ino=st.st_ino,
        st_mtime_ns=st.st_mtime_ns,
        st_size=st.st_size,
    )


def load_catalog_snapshot(cache_path: str | None) -> BuiltinFirewallCatalogSnapshot:
    """Load one trusted catalog snapshot for a consumer pass."""
    if not cache_path:
        return BuiltinFirewallCatalogSnapshot(
            None,
            None,
            unavailable_reason="cache_path_missing",
        )

    path = Path(cache_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)

    try:
        opened_file = state_file.open_state_file(
            path,
            description="builtin firewall catalog cache",
            validate_stat=_validate_cache_file_stat,
        )
    except OSError as exc:
        state.reset(path_key)
        return BuiltinFirewallCatalogSnapshot(
            None,
            None,
            cache_path=path_key,
            unavailable_reason=_open_error_unavailable_reason(exc),
        )

    with opened_file:
        key = opened_file.identity
        if state.snapshot is not None and state.snapshot.can_reuse(key):
            return state.snapshot
        reuse_by_identity = True
        unavailable_reason: CatalogUnavailableReason | None = None
        try:
            catalog = _read_catalog(
                opened_file.read_bytes(BUILTIN_FIREWALL_CATALOG_MAX_BYTES),
                key,
            )
        except (state_file.StateFileTooLargeError, ValueError, RecursionError) as exc:
            catalog = None
            unavailable_reason = "cache_invalid"
            state.read_error_key = None
            addon_process_logging.emit_addon_process_event(
                "warn",
                f"Failed to read builtin firewall catalog cache: {exc}",
            )
        except OSError as exc:
            catalog = None
            unavailable_reason = "cache_invalid"
            reuse_by_identity = False
            if state.read_error_key != key:
                addon_process_logging.emit_addon_process_event(
                    "warn",
                    f"Failed to read builtin firewall catalog cache: {exc}",
                )
            state.read_error_key = key
        else:
            state.read_error_key = None

    state.snapshot = BuiltinFirewallCatalogSnapshot(
        key,
        catalog,
        cache_path=path_key,
        unavailable_reason=unavailable_reason,
        reuse_by_identity=reuse_by_identity,
    )
    return state.snapshot


def _open_error_unavailable_reason(exc: OSError) -> CatalogUnavailableReason:
    if isinstance(exc, _CatalogCacheOpenError):
        return exc.reason
    if isinstance(exc, state_file.StateFileNotRegularError):
        return "cache_not_regular"
    if isinstance(exc, FileNotFoundError):
        return "cache_file_missing"
    if isinstance(exc, PermissionError):
        return "cache_permission_denied"
    return "cache_unavailable"


def _validate_cache_file_stat(path: Path, st: os.stat_result) -> None:
    if not _cache_file_stat_is_trusted(st):
        raise _CatalogCacheOpenError(
            "cache_untrusted",
            f"builtin firewall catalog cache is not trusted: {path}",
        )


def _cache_file_stat_is_trusted(st: os.stat_result) -> bool:
    return (
        stat.S_ISREG(st.st_mode)
        and st.st_uid == os.geteuid()
        and (st.st_mode & _UNTRUSTED_WRITE_BITS) == 0
    )


def _read_catalog(
    raw_bytes: bytes,
    key: CatalogFileKey,
) -> BuiltinFirewallCatalog:
    raw = json.loads(raw_bytes.decode("utf-8"))
    validated = catalog_validation.validate_catalog(raw)
    return BuiltinFirewallCatalog(
        identity=CatalogIdentity(
            source="cache",
            catalog_digest=validated.catalog_digest,
            catalog_version=validated.catalog_version,
            file_key=key,
        ),
        firewalls=validated.firewalls,
    )
