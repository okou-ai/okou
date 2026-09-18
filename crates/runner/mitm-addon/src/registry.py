"""Proxy registry loading and sandbox lookup cache."""

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import addon_process_logging
import flow_metadata
import matching
import registry_firewalls
import registry_observation
import run_usage
import state_file
from firewall_auth_cache import (
    FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE,
    evict_all_cache_keys,
    reconcile_registry_cache_ownership,
)

SandboxContext = tuple[
    dict,
    matching.CompiledFirewallSet | None,
    matching.CompiledNetworkPolicies,
]
type _RegistryFileKey = state_file.StateFileIdentity
MAX_REGISTRY_BYTES = 16 * 1024 * 1024


class _RegistrySandboxInfo(dict):
    """Published sandbox mapping with private process-local ownership state."""


class _RegistryFormatError(ValueError):
    """Registry JSON decoded successfully but does not have the expected shape."""


@dataclass(frozen=True)
class InvalidSandboxEntry:
    """Registry entry present for an IP but invalid for runtime sandbox context use.

    ``reason`` is the stable, client-visible diagnostic category. The supported
    values and their validation conditions are:

    - ``invalid_sandbox_entry``: the entry is not an object.
    - ``missing_run_id``: the ``runId`` field is absent.
    - ``invalid_run_id``: ``runId`` is not a string or has leading or trailing
      whitespace.
    - ``empty_run_id``: ``runId`` is a string whose stripped value is empty.
    - ``invalid_billable_firewalls``: ``billableFirewalls`` is not a list of
      strings.
    - ``invalid_x_resource_billing``: the advertised X resource capability is
      malformed or unsupported.
    - ``missing_cli_agent_type``: the ``cliAgentType`` field is absent.
    - ``invalid_cli_agent_type``: ``cliAgentType`` is not a string.
    - ``empty_cli_agent_type``: ``cliAgentType`` is an empty string.
    - ``invalid_firewalls``: ``firewalls`` is a non-null non-list, or firewall
      entry resolution fails.
    - ``invalid_omitted_intents``: omitted firewall or connector ID metadata is
      not a list of non-empty strings or contains duplicates.
    - ``invalid_connector_routing_variables``: connector routing metadata is
      not an object with connector identities and string-map values.

    ``message`` is the detailed validation text for the individual entry. Both
    fields are copied verbatim into the local ``invalid_registry_sandbox`` 503
    response. Consumers should use ``reason`` for category-level handling and
    treat ``message`` as diagnostic text.
    """

    reason: str
    message: str


@dataclass(frozen=True)
class _RegistrySnapshot:
    sandboxes: dict
    invalid_sandboxes: dict[str, InvalidSandboxEntry]
    compiled_firewalls: dict[str, matching.CompiledFirewallSet]
    compiled_network_policies: dict[str, matching.CompiledNetworkPolicies]
    omitted_builtin_firewalls: dict[str, frozenset[str]]
    omitted_custom_connector_ids: dict[str, frozenset[str]]
    builtin_firewall_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None
    loaded_key: _RegistryFileKey | None
    digest: str | None = None


@dataclass(frozen=True)
class RegistryUnavailable:
    """Current registry file cannot be trusted as an enforcement source.

    ``reason`` is the stable diagnostic category for the unavailable state:

    - ``stat_failed`` means the registry could not be opened or validated as a
      regular file, so no file identity was available.
    - ``read_failed`` means the opened registry could not be read, including a
      bounded-read failure.
    - ``parse_failed`` means the bytes could not be decoded or did not have the
      expected registry shape.

    ``message`` contains detailed internal failure context. The local 503
    response exposes ``reason`` as its diagnostic category but uses its own
    fixed user-visible message instead of serializing this internal detail.
    """

    reason: str
    message: str
    loaded_key: _RegistryFileKey | None = None
    digest: str | None = None


RegistryState = _RegistrySnapshot | RegistryUnavailable


def _empty_snapshot() -> _RegistrySnapshot:
    return _RegistrySnapshot({}, {}, {}, {}, {}, {}, None, None)


@dataclass
class _RegistryCacheState:
    registry_path: str | None = None
    # Successful registry state is stored in one snapshot so raw sandbox entries and
    # compiled matcher sidecars are published together.
    snapshot: _RegistrySnapshot = field(default_factory=_empty_snapshot)
    unavailable: RegistryUnavailable | None = None
    # Known-bad decoded registry input. This key should short-circuit until the
    # file changes again, while enforcement continues to see RegistryUnavailable.
    failed_key: _RegistryFileKey | None = None
    # Open/stat failures do not provide a key, so use a one-shot guard. Read
    # errors have a key but are retried on every call; track their last warning
    # key only to avoid request-path log spam without poisoning the file state.
    stat_error_logged: bool = False
    read_error_key: _RegistryFileKey | None = None
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ] = field(default_factory=dict)

    def reset(self, registry_path: str | None = None) -> None:
        self.registry_path = registry_path
        self.snapshot = _empty_snapshot()
        self.unavailable = None
        self.failed_key = None
        self.stat_error_logged = False
        self.read_error_key = None
        self.builtin_firewall_core_cache = {}


_registry_state = _RegistryCacheState()
_next_firewall_auth_registry_generation = 0


def reset_cache_for_tests() -> None:
    """Reset module cache state between tests."""
    global _next_firewall_auth_registry_generation

    _registry_state.reset()
    _next_firewall_auth_registry_generation = 0
    registry_firewalls.reset_cache_for_tests()
    registry_observation.reset()


def _allocate_firewall_auth_registry_generation() -> int:
    """Allocate ownership generations independently of registry path resets."""
    global _next_firewall_auth_registry_generation

    _next_firewall_auth_registry_generation += 1
    return _next_firewall_auth_registry_generation


def _path_key(path: Path) -> str:
    return str(path.absolute())


def _state_for_path(path_key: str) -> _RegistryCacheState:
    if _registry_state.registry_path != path_key:
        if _registry_state.snapshot.loaded_key is not None:
            evict_all_cache_keys()
        _registry_state.reset(path_key)
    return _registry_state


def _compile_registry(
    new_registry: dict,
    builtin_cache_keys: dict[
        str,
        tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...],
    ],
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> tuple[
    dict[str, matching.CompiledFirewallSet],
    dict[str, matching.CompiledNetworkPolicies],
]:
    compiled_firewall_registry: dict[str, matching.CompiledFirewallSet] = {}
    compiled_policy_registry: dict[str, matching.CompiledNetworkPolicies] = {}
    for client_ip, sandbox in new_registry.items():
        firewalls = sandbox.get("firewalls")
        compiled_firewalls = _compile_firewalls_with_builtin_cache(
            firewalls,
            builtin_cache_keys.get(client_ip),
            builtin_firewall_core_cache,
        )
        if compiled_firewalls is not None:
            compiled_firewall_registry[client_ip] = compiled_firewalls
        network_policies = sandbox.get("networkPolicies")
        compiled_policy_registry[client_ip] = matching.compile_network_policies(network_policies)
    _prune_builtin_firewall_core_cache(builtin_firewall_core_cache, builtin_cache_keys.values())
    return compiled_firewall_registry, compiled_policy_registry


def _prune_builtin_firewall_core_cache(
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
    active_key_groups: Iterable[tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...]],
) -> None:
    active_keys = {
        cache_key
        for cache_keys in active_key_groups
        for cache_key in cache_keys
        if cache_key is not None
    }
    stale_keys = set(builtin_firewall_core_cache) - active_keys
    for cache_key in stale_keys:
        del builtin_firewall_core_cache[cache_key]


def _compile_firewalls_with_builtin_cache(
    firewalls: object | None,
    builtin_cache_keys: tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...] | None,
    builtin_firewall_core_cache: dict[
        registry_firewalls.BuiltinFirewallCoreCacheKey,
        matching.CompiledFirewallCore,
    ],
) -> matching.CompiledFirewallSet | None:
    if not isinstance(firewalls, list) or not firewalls:
        return None
    if builtin_cache_keys is None or len(builtin_cache_keys) != len(firewalls):
        return matching.compile_firewalls(firewalls)

    compiled_firewalls = []
    for firewall, cache_key in zip(firewalls, builtin_cache_keys, strict=False):
        if not isinstance(firewall, dict):
            continue
        if cache_key is None:
            inline_compiled = matching.compile_firewalls([firewall])
            if inline_compiled is not None:
                compiled_firewalls.extend(inline_compiled.firewalls)
            continue

        compiled_core = builtin_firewall_core_cache.get(cache_key)
        if compiled_core is None:
            compiled_core = matching.compile_firewall_core(firewall)
            if compiled_core is None:
                continue
            builtin_firewall_core_cache[cache_key] = compiled_core
        compiled_firewall = matching.bind_compiled_firewall_core(firewall, compiled_core)
        if compiled_firewall is not None:
            compiled_firewalls.append(compiled_firewall)

    if not compiled_firewalls:
        return None
    return matching.CompiledFirewallSet(tuple(compiled_firewalls))


def _builtin_firewall_catalog_cache_path() -> str | None:
    return registry_firewalls.configured_catalog_cache_path()


def _classify_registry_sandboxes(
    raw_registry: dict,
    *,
    builtin_firewall_catalog_cache_path: str | None,
) -> tuple[
    dict,
    dict[str, InvalidSandboxEntry],
    dict[str, tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...]],
    dict[str, frozenset[str]],
    dict[str, frozenset[str]],
    registry_firewalls.BuiltinFirewallCatalogSnapshot | None,
]:
    new_registry: dict = {}
    invalid_sandboxes: dict[str, InvalidSandboxEntry] = {}
    builtin_cache_keys_by_client_ip: dict[
        str,
        tuple[registry_firewalls.BuiltinFirewallCoreCacheKey | None, ...],
    ] = {}
    omitted_builtin_firewalls: dict[str, frozenset[str]] = {}
    omitted_custom_connector_ids: dict[str, frozenset[str]] = {}
    builtin_catalog_snapshot: registry_firewalls.BuiltinFirewallCatalogSnapshot | None = None
    for client_ip, sandbox in raw_registry.items():
        if not isinstance(sandbox, dict):
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_sandbox_entry",
                "proxy registry sandbox entry must be an object",
            )
            continue

        if "runId" not in sandbox:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "missing_run_id",
                "proxy registry sandbox entry is missing runId",
            )
            continue

        run_id = sandbox["runId"]
        if not isinstance(run_id, str):
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_run_id",
                "proxy registry sandbox entry runId must be a string",
            )
            continue
        if not run_id.strip():
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "empty_run_id",
                "proxy registry sandbox entry runId must be non-empty",
            )
            continue
        if run_id != run_id.strip():
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_run_id",
                "proxy registry sandbox entry runId must not include leading or "
                "trailing whitespace",
            )
            continue

        billable_firewalls = sandbox.get("billableFirewalls")
        if not isinstance(billable_firewalls, list) or any(
            not isinstance(firewall_name, str) for firewall_name in billable_firewalls
        ):
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_billable_firewalls",
                "proxy registry sandbox entry billableFirewalls must be a list of strings",
            )
            continue

        if "xResourceBilling" in sandbox:
            try:
                flow_metadata.parse_x_resource_billing(sandbox["xResourceBilling"])
            except ValueError as error:
                invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                    "invalid_x_resource_billing", str(error)
                )
                continue

        if "cliAgentType" not in sandbox:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "missing_cli_agent_type",
                "proxy registry sandbox entry is missing cliAgentType",
            )
            continue

        cli_agent_type = sandbox["cliAgentType"]
        if not isinstance(cli_agent_type, str):
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_cli_agent_type",
                "proxy registry sandbox entry cliAgentType must be a string",
            )
            continue
        if not cli_agent_type:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "empty_cli_agent_type",
                "proxy registry sandbox entry cliAgentType must be non-empty",
            )
            continue

        if (
            "firewalls" in sandbox
            and sandbox["firewalls"] is not None
            and not isinstance(sandbox["firewalls"], list)
        ):
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_firewalls",
                "proxy registry sandbox entry firewalls must be a list",
            )
            continue

        try:
            explicit_omitted_builtins = _omitted_runtime_intents(sandbox, "omittedBuiltinFirewalls")
            explicit_omitted_custom_ids = _omitted_runtime_intents(
                sandbox, "omittedCustomConnectorIds"
            )
        except ValueError as e:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry("invalid_omitted_intents", str(e))
            continue
        try:
            _validate_connector_routing_variables(sandbox)
        except (TypeError, ValueError) as e:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry(
                "invalid_connector_routing_variables", str(e)
            )
            continue

        raw_firewalls = sandbox.get("firewalls")
        sandbox_uses_builtin_catalog_dependency = isinstance(raw_firewalls, list) and any(
            isinstance(entry, dict) and entry.get("kind") == "builtin" for entry in raw_firewalls
        )
        if sandbox_uses_builtin_catalog_dependency and builtin_catalog_snapshot is None:
            builtin_catalog_snapshot = registry_firewalls.load_catalog_snapshot(
                builtin_firewall_catalog_cache_path
            )

        try:
            resolved_firewalls = registry_firewalls.resolve_firewall_entries(
                sandbox,
                builtin_firewall_catalog_cache_path=builtin_firewall_catalog_cache_path,
                builtin_firewall_catalog_snapshot=builtin_catalog_snapshot,
            )
        except registry_firewalls.FirewallEntryResolutionError as e:
            invalid_sandboxes[client_ip] = InvalidSandboxEntry("invalid_firewalls", str(e))
            continue

        sandbox = _RegistrySandboxInfo(sandbox)
        sandbox.pop(FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE, None)
        if resolved_firewalls.firewalls is not None:
            sandbox["firewalls"] = resolved_firewalls.firewalls
            if resolved_firewalls.builtin_cache_keys is not None:
                builtin_cache_keys_by_client_ip[client_ip] = resolved_firewalls.builtin_cache_keys
            if resolved_firewalls.omitted_builtin_names:
                explicit_omitted_builtins = (
                    explicit_omitted_builtins | resolved_firewalls.omitted_builtin_names
                )

        if explicit_omitted_builtins:
            omitted_builtin_firewalls[client_ip] = explicit_omitted_builtins
        if explicit_omitted_custom_ids:
            omitted_custom_connector_ids[client_ip] = explicit_omitted_custom_ids

        new_registry[client_ip] = sandbox

    return (
        new_registry,
        invalid_sandboxes,
        builtin_cache_keys_by_client_ip,
        omitted_builtin_firewalls,
        omitted_custom_connector_ids,
        builtin_catalog_snapshot,
    )


def _omitted_runtime_intents(sandbox: dict, field_name: str) -> frozenset[str]:
    raw_values = sandbox.get(field_name, [])
    if not isinstance(raw_values, list) or any(
        not isinstance(value, str) or value == "" for value in raw_values
    ):
        raise ValueError(f"proxy registry sandbox entry {field_name} must be a string list")
    if len(set(raw_values)) != len(raw_values):
        raise ValueError(f"proxy registry sandbox entry {field_name} must be unique")
    return frozenset(raw_values)


def _validate_connector_routing_variables(sandbox: dict) -> None:
    routing_variables = sandbox.get("connectorRoutingVariables", {})
    if not isinstance(routing_variables, dict):
        raise TypeError("proxy registry sandbox entry connectorRoutingVariables must be an object")
    for identity, values in routing_variables.items():
        if not identity.startswith(("builtin:", "custom:")):
            raise ValueError(
                "proxy registry sandbox entry connectorRoutingVariables keys must "
                "identify a connector"
            )
        _, connector_identity = identity.split(":", 1)
        if connector_identity == "":
            raise ValueError(
                "proxy registry sandbox entry connectorRoutingVariables keys must "
                "identify a connector"
            )
        if not isinstance(values, dict) or any(
            not isinstance(value, str) for value in values.values()
        ):
            raise TypeError(
                "proxy registry sandbox entry connectorRoutingVariables values must be string maps"
            )
        if any(key == "" for key in values):
            raise ValueError(
                "proxy registry sandbox entry connectorRoutingVariables values must be string maps"
            )


def _read_registry_sandboxes(raw_bytes: bytes) -> dict:
    raw_registry = json.loads(raw_bytes.decode("utf-8"))
    if not isinstance(raw_registry, dict):
        raise _RegistryFormatError("proxy registry must be an object")
    raw_sandboxes = raw_registry.get("sandboxes", {})
    if not isinstance(raw_sandboxes, dict):
        raise _RegistryFormatError("proxy registry sandboxes must be an object")
    return raw_sandboxes


def _mark_unavailable(
    state: _RegistryCacheState,
    *,
    reason: str,
    message: str,
    loaded_key: _RegistryFileKey | None = None,
    digest: str | None = None,
) -> RegistryUnavailable:
    if state.unavailable is None and state.snapshot.loaded_key is not None:
        evict_all_cache_keys()
    state.snapshot = _empty_snapshot()
    state.builtin_firewall_core_cache.clear()
    state.unavailable = RegistryUnavailable(reason, message, loaded_key, digest)
    return state.unavailable


def load_registry_state(registry_path: str) -> RegistryState:
    """Load through the event-loop owner and expose only its completed observation."""
    state = _load_registry_state(registry_path)
    if isinstance(state, RegistryUnavailable):
        registry_observation.publish_unavailable(state)
    else:
        run_usage.reconcile(state.sandboxes, state.digest)
        registry_observation.publish_available(state)
    return state


def _load_registry_state(registry_path: str) -> RegistryState:
    """Load the proxy registry state, reusing cached data when possible.

    Cache state is scoped to one active registry path. A successful load
    publishes raw and compiled registry state together in a snapshot keyed by
    file identity metadata. Registry file open/stat/read/parse failures publish a
    separate unavailable state instead of returning a stale snapshot for
    enforcement. Malformed registry document input is recorded separately as a
    failed key so repeated reads of the same bad bytes do not reparse or
    re-warn. File read errors keep retrying that key, and internal
    compile/eviction errors are allowed to propagate.

    Per-entry validation failures remain in ``invalid_sandboxes`` within the
    successful snapshot while valid entries remain in ``sandboxes`` and stay
    available for enforcement. They do not make the whole registry unavailable;
    requests for an invalid entry are blocked as ``invalid_registry_sandbox``.
    A catalog dependency also owns its reuse eligibility: retryable catalog
    failures rebuild the registry even when neither file identity has changed.

    ``stat_failed`` covers failures before a file identity is available, and
    later calls retry opening the path while the stat warning guard suppresses
    duplicate warnings. ``read_failed`` covers bounded read errors; its file
    identity is not stored as a failed key, so the same identity is retried on
    the next call while ``read_error_key`` only suppresses duplicate warnings.
    ``parse_failed`` stores the file identity in ``failed_key`` and
    short-circuits subsequent calls for that identity until the file changes.
    An unavailable transition clears the previous enforcement snapshot rather
    than reusing stale registry data.
    """
    path = Path(registry_path)
    path_key = _path_key(path)
    state = _state_for_path(path_key)
    builtin_catalog_cache_path = _builtin_firewall_catalog_cache_path()

    try:
        opened_file = state_file.open_state_file(path, description="proxy registry")
    except OSError as e:
        message = str(e)
        if not state.stat_error_logged:
            state.stat_error_logged = True
            addon_process_logging.emit_addon_process_event(
                "warn",
                f"Failed to stat proxy registry: {message}",
            )
        return _mark_unavailable(state, reason="stat_failed", message=message)

    with opened_file:
        key = opened_file.identity
        loaded_catalog_snapshot = state.snapshot.builtin_firewall_catalog_snapshot
        if key == state.snapshot.loaded_key and (
            loaded_catalog_snapshot is None
            or loaded_catalog_snapshot.can_reuse(
                registry_firewalls.catalog_file_key(builtin_catalog_cache_path)
            )
        ):
            state.unavailable = None
            state.stat_error_logged = False
            state.read_error_key = None
            return state.snapshot
        if key == state.failed_key:
            return state.unavailable or _mark_unavailable(
                state,
                reason="parse_failed",
                message="proxy registry is unavailable",
            )

        digest = None
        try:
            raw_bytes = opened_file.read_bytes(MAX_REGISTRY_BYTES)
            digest = hashlib.sha256(raw_bytes).hexdigest()
            raw_registry = _read_registry_sandboxes(raw_bytes)
            del raw_bytes
        except OSError as e:
            message = str(e)
            state.failed_key = None
            if key != state.read_error_key:
                state.read_error_key = key
                addon_process_logging.emit_addon_process_event(
                    "warn",
                    f"Failed to read proxy registry: {message}",
                )
            return _mark_unavailable(state, reason="read_failed", message=message, loaded_key=key)
        except (ValueError, RecursionError) as e:
            message = str(e)
            state.failed_key = key
            state.read_error_key = None
            addon_process_logging.emit_addon_process_event(
                "warn",
                f"Failed to parse proxy registry: {message}",
            )
            return _mark_unavailable(
                state, reason="parse_failed", message=message, loaded_key=key, digest=digest
            )

    (
        new_registry,
        invalid_sandboxes,
        builtin_cache_keys,
        omitted_builtin_firewalls,
        omitted_custom_connector_ids,
        builtin_catalog_snapshot,
    ) = _classify_registry_sandboxes(
        raw_registry,
        builtin_firewall_catalog_cache_path=builtin_catalog_cache_path,
    )
    if invalid_sandboxes and (
        key != state.snapshot.loaded_key or invalid_sandboxes != state.snapshot.invalid_sandboxes
    ):
        addon_process_logging.emit_addon_process_event(
            "warn",
            f"Rejected {len(invalid_sandboxes)} invalid proxy registry sandbox entries",
        )
    new_compiled_registry, new_compiled_policy_registry = _compile_registry(
        new_registry,
        builtin_cache_keys,
        state.builtin_firewall_core_cache,
    )

    firewall_auth_registry_generation = _allocate_firewall_auth_registry_generation()
    for sandbox in new_registry.values():
        setattr(
            sandbox,
            FIREWALL_AUTH_REGISTRY_GENERATION_ATTRIBUTE,
            firewall_auth_registry_generation,
        )

    active_run_generations = {
        sandbox["runId"]: firewall_auth_registry_generation for sandbox in new_registry.values()
    }
    reconcile_registry_cache_ownership(active_run_generations)

    state.snapshot = _RegistrySnapshot(
        new_registry,
        invalid_sandboxes,
        new_compiled_registry,
        new_compiled_policy_registry,
        omitted_builtin_firewalls,
        omitted_custom_connector_ids,
        builtin_catalog_snapshot,
        key,
        digest,
    )
    state.unavailable = None
    state.failed_key = None
    state.stat_error_logged = False
    state.read_error_key = None
    return state.snapshot


def load_registry(registry_path: str) -> dict:
    """Load a lossy compatibility view containing only usable sandbox entries.

    Invalid entries are omitted. An empty mapping can mean either that a
    successfully loaded registry has no usable entries or that the registry is
    unavailable after an open, stat, read, or parse failure. Use
    `load_registry_state()` when those states must be distinguished.
    """
    state = load_registry_state(registry_path)
    if isinstance(state, RegistryUnavailable):
        return {}
    return state.sandboxes


def get_sandbox_info(client_ip: str, registry_path: str) -> dict | None:
    """Look up sandbox info in the lossy compatibility view for a client IP.

    `None` can mean that the IP is absent, its registry entry is invalid, or the
    registry is unavailable. Use `load_registry_state()` when those states must
    be distinguished.
    """
    return load_registry(registry_path).get(client_ip)


def get_sandbox_context(
    client_ip: str,
    registry_path: str,
) -> SandboxContext | None:
    """Look up raw sandbox info with compiled matcher sidecars in a compatibility view.

    `None` can mean that the IP is absent, its registry entry is invalid, or the
    registry is unavailable. Use `load_registry_state()` when those states must
    be distinguished.
    """
    snapshot = load_registry_state(registry_path)
    if isinstance(snapshot, RegistryUnavailable):
        return None
    sandbox_info = snapshot.sandboxes.get(client_ip)
    if sandbox_info is None:
        return None
    return (
        sandbox_info,
        snapshot.compiled_firewalls.get(client_ip),
        snapshot.compiled_network_policies[client_ip],
    )
