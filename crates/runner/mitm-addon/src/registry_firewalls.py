"""Registry sandbox firewall entry resolution."""

import copy
import uuid
from dataclasses import dataclass

import builtin_base_url
import builtin_firewall_cache
import builtin_host_policy
import connector_runtime_metadata

BuiltinFirewallCatalogFileKey = builtin_firewall_cache.CatalogFileKey
BuiltinFirewallCatalogIdentity = builtin_firewall_cache.CatalogIdentity
BuiltinFirewallCatalogSnapshot = builtin_firewall_cache.BuiltinFirewallCatalogSnapshot
BuiltinFirewallCoreCacheKey = tuple[
    str,
    BuiltinFirewallCatalogIdentity,
    tuple[tuple[str, str], ...],
    tuple[str, ...],
]


class FirewallEntryResolutionError(ValueError):
    """Execution firewall entries could not be expanded into runtime configs."""


def _validated_uuid_string(value: object, *, message: str) -> str:
    """Validate a registry UUID string without changing its original spelling."""
    if not isinstance(value, str):
        raise FirewallEntryResolutionError(message)
    try:
        uuid.UUID(value)
    except ValueError as error:
        raise FirewallEntryResolutionError(message) from error
    return value


def _optional_uuid_field(entry: dict, field: str, *, message: str) -> str | None:
    """Read an optional registry identity; missing and null fields stay absent."""
    value = entry.get(field)
    if value is None:
        return None
    return _validated_uuid_string(value, message=message)


def _apply_source_id(firewall: dict, source_id: str | None) -> None:
    if source_id is None:
        return
    firewall["sourceId"] = source_id
    raw_apis = firewall.get("apis")
    if not isinstance(raw_apis, list):
        raise FirewallEntryResolutionError("firewall apis must be a list")
    for api in raw_apis:
        if isinstance(api, dict):
            api["sourceId"] = source_id


def _connector_runtime_target_ids(sandbox: dict) -> tuple[set[str], set[str]]:
    raw_targets = sandbox.get("connectorRuntimeTargets", [])
    if not isinstance(raw_targets, list):
        raise FirewallEntryResolutionError("connectorRuntimeTargets must be a list")
    builtin_slugs: set[str] = set()
    custom_connector_ids: set[str] = set()
    for target in raw_targets:
        if not isinstance(target, dict):
            raise FirewallEntryResolutionError("connector runtime targets must be objects")
        kind = target.get("kind")
        if kind == "builtin":
            connector_slug = target.get("connectorSlug")
            if not isinstance(connector_slug, str) or connector_slug == "":
                raise FirewallEntryResolutionError(
                    "builtin connector runtime target must have a connector slug"
                )
            if connector_slug in builtin_slugs:
                raise FirewallEntryResolutionError(
                    "builtin connector runtime targets must be unique"
                )
            builtin_slugs.add(connector_slug)
            continue
        if kind == "custom":
            custom_connector_id = _validated_uuid_string(
                target.get("customConnectorId"),
                message="custom connector runtime target must have a UUID",
            )
            if custom_connector_id in custom_connector_ids:
                raise FirewallEntryResolutionError(
                    "custom connector runtime targets must be unique"
                )
            custom_connector_ids.add(custom_connector_id)
            continue
        raise FirewallEntryResolutionError("connector runtime targets must use a supported kind")
    return builtin_slugs, custom_connector_ids


@dataclass(frozen=True, slots=True)
class ResolvedFirewallEntry:
    """A resolved configuration bound to its optional builtin core-cache key."""

    firewall: dict
    cache_key: BuiltinFirewallCoreCacheKey | None


@dataclass(frozen=True)
class ResolvedFirewallEntries:
    """Ordered registry firewall configurations with their cache provenance.

    `entries` contains the runtime configurations after builtin and inline
    expansion. `entries is None` preserves an absent or null `firewalls` source;
    an empty tuple preserves a present but empty resolved source.

    Each entry keeps its configuration with its builtin core-cache key. A key
    of `None` means an inline entry that bypasses builtin core-cache reuse.
    `omitted_builtin_names` records compact builtin references absent from the
    otherwise valid current catalog.
    """

    entries: tuple[ResolvedFirewallEntry, ...] | None
    omitted_builtin_names: frozenset[str] = frozenset()

    def __post_init__(self) -> None:
        if self.entries is None and self.omitted_builtin_names:
            raise ValueError("omitted builtin names must be absent when firewalls are absent")


def reset_cache_for_tests() -> None:
    """Reset builtin firewall resolver cache state between tests."""
    clear_catalog_cache()


def clear_catalog_cache() -> None:
    """Drop the cached builtin firewall catalog snapshot."""
    builtin_firewall_cache.clear_cache()


def configured_catalog_cache_path() -> str | None:
    """Return the runner-configured builtin catalog cache path."""
    return builtin_firewall_cache.configured_catalog_cache_path()


def catalog_file_key(
    cache_path: str | None,
) -> builtin_firewall_cache.CatalogFileKey | None:
    """Return the registry-facing builtin catalog cache identity."""
    return builtin_firewall_cache.catalog_file_key(cache_path)


def load_catalog_snapshot(cache_path: str | None) -> BuiltinFirewallCatalogSnapshot:
    """Load the registry-facing builtin catalog snapshot for one resolver pass."""
    return builtin_firewall_cache.load_catalog_snapshot(cache_path)


def _copy_builtin_firewall_shell(
    *,
    firewall_name: str,
    catalog_firewall: dict,
) -> tuple[dict, list[dict]]:
    raw_apis = catalog_firewall.get("apis")
    if not isinstance(raw_apis, list):
        raise FirewallEntryResolutionError(
            f'builtin firewall "{firewall_name}" apis must be a list'
        )

    copied_apis: list[dict] = []
    for api in raw_apis:
        if not isinstance(api, dict):
            raise FirewallEntryResolutionError(
                f'builtin firewall "{firewall_name}" api entries must be objects'
            )
        copied_api = dict(api)
        copied_api.pop("id", None)
        copied_api.pop(builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER, None)
        copied_apis.append(copied_api)

    firewall = dict(catalog_firewall)
    firewall["apis"] = copied_apis
    return firewall, copied_apis


def _resolution_error(error: Exception) -> FirewallEntryResolutionError:
    return FirewallEntryResolutionError(str(error))


def _catalog_source_for_name(
    raw_name: str,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
) -> tuple[dict, BuiltinFirewallCatalogIdentity] | None:
    cached_catalog = catalog_snapshot.catalog
    if cached_catalog is None:
        reason = catalog_snapshot.unavailable_reason or "cache_unavailable"
        if catalog_snapshot.cache_path is None:
            raise FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" catalog cache unavailable: {reason}'
            )
        raise FirewallEntryResolutionError(
            f'builtin firewall "{raw_name}" catalog cache unavailable: '
            f"{reason} ({catalog_snapshot.cache_path})"
        )
    catalog_firewall = cached_catalog.firewalls.get(raw_name)
    if catalog_firewall is None:
        return None
    return catalog_firewall, cached_catalog.identity


def _resolve_builtin_firewall_entry(
    entry: dict,
    *,
    raw_name: str,
    catalog_snapshot: BuiltinFirewallCatalogSnapshot,
) -> ResolvedFirewallEntry | None:
    catalog_source = _catalog_source_for_name(raw_name, catalog_snapshot)
    if catalog_source is None:
        return None
    catalog_firewall, catalog_identity = catalog_source

    firewall, raw_apis = _copy_builtin_firewall_shell(
        firewall_name=raw_name,
        catalog_firewall=catalog_firewall,
    )

    try:
        vars_map = builtin_base_url.base_url_vars_for_entry(entry)
    except builtin_base_url.BuiltinBaseUrlResolutionError as e:
        raise _resolution_error(e) from e

    resolved_bases: list[str] = []
    for api in raw_apis:
        raw_base = api.get("base")
        if not isinstance(raw_base, str):
            raise FirewallEntryResolutionError(
                f'builtin firewall "{raw_name}" api base must be a string'
            )
        try:
            resolved_base = builtin_base_url.resolve_base_url_template(
                firewall_name=raw_name,
                base=raw_base,
                vars_map=vars_map,
            )
            compiled_host_policy = builtin_host_policy.validate_credentialed_builtin_base(
                firewall_name=raw_name,
                base=resolved_base,
                auth_config=api.get("auth"),
                host_policy=api.get("hostPolicy"),
            )
        except (
            builtin_base_url.BuiltinBaseUrlResolutionError,
            builtin_host_policy.BuiltinHostPolicyError,
        ) as e:
            raise _resolution_error(e) from e
        api["base"] = resolved_base
        if api.get("hostPolicy") is not None:
            api[builtin_host_policy.BUILTIN_HOST_POLICY_RUNTIME_MARKER] = (
                compiled_host_policy if compiled_host_policy is not None else True
            )
        resolved_bases.append(resolved_base)

    return ResolvedFirewallEntry(
        firewall=firewall,
        cache_key=(
            raw_name,
            catalog_identity,
            tuple(sorted(vars_map.items())),
            tuple(resolved_bases),
        ),
    )


def _assign_firewall_api_ids(entries: list[ResolvedFirewallEntry], run_id: str) -> None:
    index = 0
    for entry in entries:
        firewall = entry.firewall
        raw_apis = firewall.get("apis")
        if not isinstance(raw_apis, list):
            continue
        for api in raw_apis:
            if not isinstance(api, dict):
                continue
            raw_id = api.get("id")
            if not isinstance(raw_id, str) or raw_id == "":
                api["id"] = f"{run_id}:{index}"
            index += 1


def resolve_firewall_entries(
    sandbox: dict,
    *,
    builtin_firewall_catalog_cache_path: str | None = None,
    builtin_firewall_catalog_snapshot: BuiltinFirewallCatalogSnapshot | None = None,
    explicit_omitted_builtin_names: frozenset[str] = frozenset(),
) -> ResolvedFirewallEntries:
    """Expand a registry sandbox's firewall entries into runtime firewall configs.

    Supported entry kinds are `builtin` and `inline`. Builtins resolve from the
    supplied catalog snapshot when provided, otherwise from the catalog cache
    path. A supplied snapshot pins builtin resolution for this call so a single
    registry pass cannot mix catalog versions.

    Inline firewalls are deep-copied, must contain a list-valued `apis` field,
    and carry a `None` builtin cache key in their resolved entry. Builtin catalog API IDs are
    discarded during expansion, so builtin APIs receive generated run-scoped
    IDs. Inline APIs preserve an existing non-empty string ID; absent, empty, or
    non-string IDs are generated. Generated IDs use `<runId>:<index>`, where the
    zero-based index advances over dictionary API entries in resolved firewall
    order, including entries whose IDs are preserved. Callers must validate
    `sandbox["runId"]` as a non-empty string before calling.

    When `sandbox["firewalls"]` is present, `connectorRuntimeTargets` defaults to
    an empty list when absent. When supplied, it must be a list of object targets.
    A `builtin` target requires a non-empty string `connectorSlug`, and a
    `custom` target requires a UUID string `customConnectorId`. Builtin slugs and
    custom connector IDs must each be unique within their target kind. Missing
    or unsupported kinds, malformed target entries, missing or invalid identities,
    and duplicate identities raise `FirewallEntryResolutionError`.

    Runtime ownership metadata is assigned by the registry rather than trusted
    from source firewall data. Resolution clears any source-provided
    `_connectorRuntimeKind` marker, marks a resolved builtin as `builtin` only
    when its name is registered in `connectorRuntimeTargets`, and marks an inline
    custom firewall as `custom` only when its UUID is registered there. Unregistered
    or absent connector identities remain unclassified.

    Optional entry `sourceId` values must be UUID strings and are copied to the
    resolved firewall and each dictionary API entry. An optional inline
    `customConnectorId` must also be a UUID string and is copied to the resolved
    firewall and each dictionary API entry. The registry-owned runtime marker is
    consumed by request matching: when a registered custom candidate's base matches
    a request, registered builtin candidates are excluded before base/rule specificity
    unless present intent identifies a matching registered builtin. Bases need not
    be equal; a broader custom base can exclude a narrower builtin base. Intent
    retains eligibility, not an override of specificity or authorization. A matching
    custom denial or malformed configuration does not reconsider excluded builtins.
    Unclassified entries are not excluded by this rule. Auth resolution
    carries the propagated connector and source identities into the auth request
    context. If resolution raises `FirewallEntryResolutionError`, the registry
    loader records the affected sandbox as `invalid_firewalls` instead of
    accepting partially classified runtime ownership.

    Builtin names explicitly omitted by runtime state, or absent from a valid
    current catalog, are omitted and returned in `omitted_builtin_names`.
    Explicit omission is applied before catalog resolution so stale catalog
    snapshots cannot reactivate a terminally absent connector. Raises
    `FirewallEntryResolutionError` for an unavailable catalog, malformed
    connector runtime targets, invalid connector identities, duplicate target
    identities, malformed firewall lists or entries, unsupported entry kinds,
    invalid builtin base URL templates, and builtin host-policy validation
    failures.
    """
    raw_firewalls = sandbox.get("firewalls")
    if raw_firewalls is None:
        return ResolvedFirewallEntries(None)
    if not isinstance(raw_firewalls, list):
        raise FirewallEntryResolutionError("firewalls must be a list")

    resolved: list[ResolvedFirewallEntry] = []
    omitted_builtin_names = set(explicit_omitted_builtin_names)
    builtin_target_slugs, custom_target_ids = _connector_runtime_target_ids(sandbox)
    for entry in raw_firewalls:
        if not isinstance(entry, dict):
            raise FirewallEntryResolutionError("firewall entries must be objects")

        kind = entry.get("kind")
        if kind == "builtin":
            raw_name = entry.get("name")
            if not isinstance(raw_name, str) or raw_name == "":
                raise FirewallEntryResolutionError(
                    "builtin firewall entry name must be a non-empty string"
                )
            if raw_name in explicit_omitted_builtin_names:
                continue
            source_id = _optional_uuid_field(
                entry, "sourceId", message="firewall sourceId must be a UUID"
            )
            if builtin_firewall_catalog_snapshot is None:
                builtin_firewall_catalog_snapshot = load_catalog_snapshot(
                    builtin_firewall_catalog_cache_path
                )
            resolved_builtin = _resolve_builtin_firewall_entry(
                entry,
                raw_name=raw_name,
                catalog_snapshot=builtin_firewall_catalog_snapshot,
            )
            if resolved_builtin is None:
                omitted_builtin_names.add(raw_name)
                continue
            connector_runtime_metadata.clear_connector_runtime_kind(resolved_builtin.firewall)
            _apply_source_id(resolved_builtin.firewall, source_id)
            if raw_name in builtin_target_slugs:
                connector_runtime_metadata.mark_connector_runtime_kind(
                    resolved_builtin.firewall, "builtin"
                )
            resolved.append(resolved_builtin)
            continue
        if kind == "inline":
            firewall = entry.get("firewall")
            if not isinstance(firewall, dict):
                raise FirewallEntryResolutionError(
                    "inline firewall entry firewall must be an object"
                )
            resolved_firewall = copy.deepcopy(firewall)
            raw_apis = resolved_firewall.get("apis")
            if not isinstance(raw_apis, list):
                raise FirewallEntryResolutionError("inline firewall apis must be a list")
            connector_runtime_metadata.clear_connector_runtime_kind(resolved_firewall)
            _apply_source_id(
                resolved_firewall,
                _optional_uuid_field(entry, "sourceId", message="firewall sourceId must be a UUID"),
            )
            custom_connector_id = _optional_uuid_field(
                entry,
                "customConnectorId",
                message="inline firewall customConnectorId must be a UUID",
            )
            if custom_connector_id is not None:
                resolved_firewall["customConnectorId"] = custom_connector_id
                if custom_connector_id in custom_target_ids:
                    connector_runtime_metadata.mark_connector_runtime_kind(
                        resolved_firewall, "custom"
                    )
                for api in raw_apis:
                    if isinstance(api, dict):
                        intent = api.get("networkIntent")
                        if intent is not None:
                            if not isinstance(intent, dict):
                                raise FirewallEntryResolutionError(
                                    "custom network intent must be an object"
                                )
                            if intent.get("kind") == "direct":
                                if set(intent) != {"kind"}:
                                    raise FirewallEntryResolutionError(
                                        "Direct intent has unexpected fields"
                                    )
                            elif intent.get("kind") == "cloudflare_access":
                                if (
                                    set(intent) != {"kind", "configId", "generation"}
                                    or isinstance(intent.get("generation"), bool)
                                    or not isinstance(intent.get("generation"), int)
                                    or not 1 <= intent["generation"] <= 2**31 - 1
                                    or _optional_uuid_field(
                                        intent,
                                        "configId",
                                        message="Cloudflare configId must be a UUID",
                                    )
                                    is None
                                ):
                                    raise FirewallEntryResolutionError(
                                        "Cloudflare intent requires a configId"
                                    )
                            else:
                                raise FirewallEntryResolutionError(
                                    "unsupported custom network intent"
                                )
                        api["customConnectorId"] = custom_connector_id
            resolved.append(ResolvedFirewallEntry(firewall=resolved_firewall, cache_key=None))
            continue
        raise FirewallEntryResolutionError("firewall entries must use a supported kind")

    _assign_firewall_api_ids(resolved, sandbox["runId"])
    return ResolvedFirewallEntries(
        tuple(resolved),
        frozenset(omitted_builtin_names),
    )
