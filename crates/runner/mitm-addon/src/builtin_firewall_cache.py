"""Runner-written builtin firewall catalog cache reader."""

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NamedTuple

from mitmproxy import ctx

import addon_process_logging
import builtin_base_url_template
import builtin_host_policy
import matching
import state_file
from generated.builtin_firewall_cache import (
    BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
    BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
)
from path_security import has_unsafe_url_path
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

_SHA256_HEX_LENGTH = 64
_UNTRUSTED_WRITE_BITS = stat.S_IWGRP | stat.S_IWOTH
# Keep component witnesses small; hostname fragments also preserve adjacent
# literal label boundaries when materialized below.
_BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER = "https://x.y"
_BASE_URL_TEMPLATE_HOST_PLACEHOLDER = "x.y"
_BASE_URL_TEMPLATE_PORT_PLACEHOLDER = "1"
_BASE_URL_TEMPLATE_PATH_PLACEHOLDER = "x"
_BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS = re.compile(r"[.:/?#@\[\]\u3002\uff0e\uff61]")
_BASE_URL_TEMPLATE_PLACEHOLDERS: dict[
    builtin_base_url_template.BaseUrlTemplateComponentKind, str
] = {
    "whole-base": _BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER,
    "whole-authority": _BASE_URL_TEMPLATE_HOST_PLACEHOLDER,
    "authority-fragment": _BASE_URL_TEMPLATE_HOST_PLACEHOLDER,
    "port": _BASE_URL_TEMPLATE_PORT_PLACEHOLDER,
    "path": _BASE_URL_TEMPLATE_PATH_PLACEHOLDER,
}


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


class BuiltinFirewallCatalogCacheError(ValueError):
    """Builtin firewall catalog cache is unavailable or malformed."""


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
    Both the loader and dependent registry snapshots use `can_reuse()`; the
    diagnostic reason alone does not establish reuse eligibility.
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
    if not isinstance(raw, dict):
        raise BuiltinFirewallCatalogCacheError("catalog cache must be an object")

    schema_version = raw.get("schemaVersion")
    if not isinstance(schema_version, int) or isinstance(schema_version, bool):
        raise BuiltinFirewallCatalogCacheError("catalog cache schemaVersion must be an integer")
    if schema_version != BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION:
        raise BuiltinFirewallCatalogCacheError(
            f"unsupported catalog cache schemaVersion {schema_version}"
        )

    catalog_digest = raw.get("catalogDigest")
    if not isinstance(catalog_digest, str) or not _is_valid_catalog_digest(catalog_digest):
        raise BuiltinFirewallCatalogCacheError("catalog cache catalogDigest is invalid")
    catalog_version = raw.get("catalogVersion")
    if not isinstance(catalog_version, str) or catalog_version == "":
        raise BuiltinFirewallCatalogCacheError(
            "catalog cache catalogVersion must be a non-empty string"
        )

    firewalls = raw.get("firewalls")
    if not isinstance(firewalls, dict) or not firewalls:
        raise BuiltinFirewallCatalogCacheError("catalog cache firewalls must be a non-empty object")
    _validate_firewall_map(firewalls)

    return BuiltinFirewallCatalog(
        identity=CatalogIdentity(
            source="cache",
            catalog_digest=catalog_digest,
            catalog_version=catalog_version,
            file_key=key,
        ),
        firewalls=firewalls,
    )


def _is_valid_catalog_digest(value: str) -> bool:
    prefix = "sha256:"
    if not value.startswith(prefix):
        return False
    digest = value[len(prefix) :]
    return (
        len(digest) == _SHA256_HEX_LENGTH
        and digest == digest.lower()
        and all(char in "0123456789abcdef" for char in digest)
    )


def _validate_firewall_map(firewalls: dict[str, dict]) -> None:
    for name, firewall in firewalls.items():
        if not isinstance(name, str) or name == "":
            raise BuiltinFirewallCatalogCacheError("catalog cache firewall keys must be non-empty")
        if not isinstance(firewall, dict):
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{name}" must be an object'
            )
        if firewall.get("name") != name:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall key "{name}" does not match firewall.name'
            )
        apis = firewall.get("apis")
        if not isinstance(apis, list) or not apis:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{name}" apis must be a non-empty list'
            )
        for api in apis:
            if not isinstance(api, dict):
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{name}" api entries must be objects'
                )
            _validate_api_entry(name, api)


def _validate_api_entry(firewall_name: str, api: dict) -> None:
    raw_base = api.get("base")
    if not isinstance(raw_base, str) or raw_base == "":
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base must be non-empty'
        )
    template_syntax_target = _base_url_template_syntax_target(firewall_name, raw_base)
    raw_syntax_target = template_syntax_target or raw_base
    if (
        "\\" in raw_syntax_target
        or has_raw_whitespace(raw_syntax_target)
        or has_unsafe_url_codepoint(raw_syntax_target)
        or "?" in raw_syntax_target
        or "#" in raw_syntax_target
    ):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base has invalid syntax'
        )
    if template_syntax_target is not None and has_unsafe_url_path(template_syntax_target):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base has unsafe path'
        )
    if not matching.firewall_base_config_is_valid(raw_syntax_target):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api base is invalid'
        )

    if not matching.firewall_api_auth_config_is_valid(api):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api auth is invalid'
        )

    host_policy = api.get("hostPolicy")
    builtin_host_policy.validate_host_policy_shape_for_cache(
        firewall_name=firewall_name,
        host_policy=host_policy,
    )

    permissions = api.get("permissions")
    if permissions is None:
        return
    if not isinstance(permissions, list):
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api permissions must be a list'
        )

    seen_names: set[str] = set()
    for permission in permissions:
        if not isinstance(permission, dict):
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permissions must be objects'
            )
        raw_name = permission.get("name")
        if not isinstance(raw_name, str):
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission names must be non-empty'
            )
        invalid_reason = matching.declared_firewall_permission_name_invalid_reason(raw_name)
        if invalid_reason == "empty":
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission names must be non-empty'
            )
        if invalid_reason == "reserved":
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission name is reserved'
            )
        if raw_name in seen_names:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission names must be unique per api'
            )
        seen_names.add(raw_name)

        rules = permission.get("rules")
        if not isinstance(rules, list) or not rules:
            raise BuiltinFirewallCatalogCacheError(
                f'catalog cache firewall "{firewall_name}" permission rules must be non-empty'
            )
        for rule in rules:
            if not isinstance(rule, str) or rule == "":
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{firewall_name}" permission rules must be strings'
                )
            if not matching.firewall_rule_is_valid(rule):
                raise BuiltinFirewallCatalogCacheError(
                    f'catalog cache firewall "{firewall_name}" permission rule is invalid'
                )


def _base_url_template_syntax_target(firewall_name: str, raw_base: str) -> str | None:
    try:
        variables = builtin_base_url_template.analyze_base_url_template(raw_base)
    except builtin_base_url_template.BaseUrlTemplateLayoutError as e:
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api {e}'
        ) from e
    if not variables:
        return None

    result: list[str] = []
    last_index = 0
    for index, variable in enumerate(variables):
        reference = variable.reference
        result.append(raw_base[last_index : reference.start])
        placeholder = _BASE_URL_TEMPLATE_PLACEHOLDERS[variable.kind]
        if variable.authority_fragment_shape == "ip-literal":
            placeholder = _BASE_URL_TEMPLATE_PORT_PLACEHOLDER
        elif variable.authority_fragment_shape == "hostname":
            literal_end = (
                variables[index + 1].reference.start
                if index + 1 < len(variables)
                else len(raw_base)
            )
            placeholder = _base_url_template_hostname_placeholder(
                raw_base[last_index : reference.start], raw_base[reference.end : literal_end]
            )
        result.append(placeholder)
        last_index = reference.end
    result.append(raw_base[last_index:])
    return "".join(result)


def _base_url_template_hostname_placeholder(prefix: str, suffix: str) -> str:
    prefix_label = _BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS.split(prefix)[-1]
    suffix_label = _BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS.split(suffix, maxsplit=1)[0]
    # A variable may supply a dot, so a complete literal label need not grow.
    # Incomplete labels still join the witness; final URL validation checks both.
    leading_dot = "." if _base_url_template_literal_label_is_valid(prefix_label) else ""
    trailing_dot = "." if _base_url_template_literal_label_is_valid(suffix_label) else ""
    return f"{leading_dot}{_BASE_URL_TEMPLATE_HOST_PLACEHOLDER}{trailing_dot}"


def _base_url_template_literal_label_is_valid(label: str) -> bool:
    return (
        bool(label) and matching.static_firewall_base_config_key(f"https://x.{label}.y") is not None
    )
