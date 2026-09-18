"""Firewall URL/host/path pattern matching functions.

Pure functions with no module-level state or I/O.

Firewall authority matching intentionally differs from trusted request
authority and auth.base rewrite validation: config parsing may preserve
malformed authority metadata so matched malformed configs can fail closed, and
parameterized hosts are meaningful only for firewall config bases.
"""

import json
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Literal, NamedTuple
from urllib.parse import urlsplit

import connector_intent
import connector_runtime_metadata
import connector_template_syntax
from firewall_auth_config import auth_config_injects_ordinary_upstream_credentials
from firewall_matching import base_url as _firewall_base_url
from firewall_matching import patterns as _firewall_patterns
from firewall_matching.base_url import (
    _BaseSpecificity,
    _BaseUrlParts,
    _compile_firewall_config_base,
    _CompiledBase,
    _match_compiled_base_authority,
    _match_compiled_base_url_parts,
    _split_base_match_url,
    _split_https_authority_parts,
)
from firewall_matching.patterns import (
    SegmentError,
    SegmentLiteral,
    _compiled_path_segments_match,
    _iter_path_segments,
    _match_compiled_path_segments,
    _split_path_segments,
)
from path_security import has_unsafe_path
from url_syntax import (
    has_raw_whitespace,
    has_unsafe_url_codepoint,
)

firewall_base_config_is_valid = _firewall_base_url.firewall_base_config_is_valid
static_firewall_base_config_key = _firewall_base_url.static_firewall_base_config_key
static_firewall_base_authority_key = _firewall_base_url.static_firewall_base_authority_key
match_url_authority_key = _firewall_base_url.match_url_authority_key
match_base_url = _firewall_base_url.match_base_url

CompiledPathPattern = _firewall_patterns.CompiledPathPattern
_compiled_rule_path_is_valid = _firewall_patterns._compiled_rule_path_is_valid
compile_path_pattern = _firewall_patterns.compile_path_pattern
match_compiled_path = _firewall_patterns.match_compiled_path
match_host = _firewall_patterns.match_host
match_path = _firewall_patterns.match_path
match_path_prefix = _firewall_patterns.match_path_prefix
parse_segment = _firewall_patterns.parse_segment

# Firewall rules are encoded as ``"METHOD path"`` — a single-whitespace-split
# yields exactly two tokens.  Rows that fail this shape are malformed.
_RULE_TOKEN_COUNT = 2
_VALID_RULE_METHODS = frozenset(
    (
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "ANY",
    )
)
_RESERVED_DECLARED_FIREWALL_PERMISSION_NAMES = frozenset(("all", "__unknown__"))
_VALID_AUTH_BASE_SCHEME = "https"
_AUTH_TEMPLATE_START = "${{"
_AUTH_TEMPLATE_URL_PLACEHOLDER = "placeholder"

# Path-rule specificity is a Python tuple compared lexicographically from left to right. Keep
# these coordinates aligned with the labeled TypeScript ``PathSpecificity`` tuple in
# ``turbo/packages/connectors/src/firewall-rule-matcher.ts``:
#
# 1. ``literal_segments`` (``literalSegments``): number of fully literal path segments.
# 2. ``mixed_param_segments`` (``mixedParamSegments``): number of parameter segments with a
#    literal prefix or suffix.
# 3. ``plain_param_segments`` (``plainParamSegments``): number of non-greedy parameter segments
#    without a literal prefix or suffix.
# 4. ``plus_greedy_segments`` (``plusGreedySegments``): number of ``+`` greedy parameter segments.
# 5. ``negative_star_greedy_segments`` (``negativeStarGreedySegments``): the negated number of
#    ``*`` greedy parameter segments, so fewer ``*`` segments are more specific after earlier
#    coordinates tie.
# 6. ``literal_chars`` (``literalChars``): number of Unicode code points in literal text, including
#    mixed-segment prefixes and suffixes. Python ``len()`` has the same code-point meaning as the
#    TypeScript matcher’s ``codePointLength()`` for this contract.
# 7. ``segment_count`` (``segmentCount``): total number of path segments.
_PathSpecificity = tuple[int, int, int, int, int, int, int]


class _CompiledPrefixTrieNode[T](NamedTuple):
    values: tuple[T, ...]
    children: Mapping[str, "_CompiledPrefixTrieNode[T]"]


@dataclass
class _PrefixTrieBuilder[T]:
    values: list[T] = field(default_factory=list)
    children: dict[str, "_PrefixTrieBuilder[T]"] = field(default_factory=dict)


class _CompiledRule(NamedTuple):
    method: str
    raw: str
    path: CompiledPathPattern
    specificity: _PathSpecificity


class _CompiledPermission(NamedTuple):
    name: str
    rules: tuple[_CompiledRule, ...]


class _CompiledRuleEntry(NamedTuple):
    order: int
    permission: str
    rule: _CompiledRule


class _CompiledRuleMethodIndex(NamedTuple):
    fallback: tuple[_CompiledRuleEntry, ...]
    prefix_root: _CompiledPrefixTrieNode[_CompiledRuleEntry]


class _CompiledRuleIndex(NamedTuple):
    all_rules: tuple[_CompiledRuleEntry, ...]
    by_method: Mapping[str, _CompiledRuleMethodIndex]


class _CompiledApiCore(NamedTuple):
    raw_api_index: int
    base: _CompiledBase
    permissions: tuple[_CompiledPermission, ...]
    rule_index: _CompiledRuleIndex
    base_malformed: bool
    auth_malformed: bool
    injects_ordinary_upstream_credentials: bool
    permissionless: bool
    routing_identity: str | None
    # True when API compilation encountered malformed permissions/rules config.
    has_malformed_rules: bool


class _CompiledApi(NamedTuple):
    raw_api_entry: dict
    core: _CompiledApiCore

    @property
    def base(self) -> _CompiledBase:
        return self.core.base

    @property
    def permissions(self) -> tuple[_CompiledPermission, ...]:
        return self.core.permissions

    @property
    def rule_index(self) -> _CompiledRuleIndex:
        return self.core.rule_index

    @property
    def base_malformed(self) -> bool:
        return self.core.base_malformed

    @property
    def auth_malformed(self) -> bool:
        return self.core.auth_malformed

    @property
    def injects_ordinary_upstream_credentials(self) -> bool:
        return self.core.injects_ordinary_upstream_credentials

    @property
    def permissionless(self) -> bool:
        return self.core.permissionless

    @property
    def routing_identity(self) -> str | None:
        return self.core.routing_identity

    @property
    def has_malformed_rules(self) -> bool:
        return self.core.has_malformed_rules


class CompiledFirewallCore(NamedTuple):
    name: str
    intent_identity: str
    api_cores: tuple[_CompiledApiCore, ...]
    name_malformed: bool


class _CompiledFirewall(NamedTuple):
    core: CompiledFirewallCore
    apis: tuple[_CompiledApi, ...]
    connector_runtime_kind: connector_runtime_metadata.ConnectorRuntimeKind | None

    @property
    def name(self) -> str:
        return self.core.name

    @property
    def intent_identity(self) -> str:
        return self.core.intent_identity

    @property
    def name_malformed(self) -> bool:
        return self.core.name_malformed


class _CompiledApiCandidate(NamedTuple):
    order: int
    firewall: _CompiledFirewall
    api: _CompiledApi


class _CompiledApiIndex(NamedTuple):
    all_candidates: tuple[_CompiledApiCandidate, ...]
    fallback: tuple[_CompiledApiCandidate, ...]
    static_roots: Mapping[
        tuple[str, str],
        _CompiledPrefixTrieNode[_CompiledApiCandidate],
    ]


class _CompiledOrdinaryCredentialAuthorityIndex(NamedTuple):
    static_authorities: frozenset[str]
    parameterized_bases: tuple[_CompiledBase, ...]


@dataclass(frozen=True, init=False, slots=True, eq=False, repr=False)
class CompiledFirewallSet:
    firewalls: tuple[_CompiledFirewall, ...]
    _api_index: _CompiledApiIndex = field(compare=False, repr=False)
    _ordinary_credential_authority_index: _CompiledOrdinaryCredentialAuthorityIndex = field(
        compare=False,
        repr=False,
    )

    def __init__(self, firewalls: tuple[_CompiledFirewall, ...]) -> None:
        object.__setattr__(self, "firewalls", firewalls)
        object.__setattr__(self, "_api_index", _compile_api_candidate_index(firewalls))
        object.__setattr__(
            self,
            "_ordinary_credential_authority_index",
            _compile_ordinary_credential_authority_index(firewalls),
        )

    def __bool__(self) -> bool:
        return bool(self.firewalls)

    def indexed_api_candidates(self, url_parts: _BaseUrlParts) -> tuple[_CompiledApiCandidate, ...]:
        return _indexed_api_candidates(self._api_index, url_parts)

    def linear_api_candidates(self) -> tuple[_CompiledApiCandidate, ...]:
        return self._api_index.all_candidates

    def matches_ordinary_credential_authority(self, host: str, port: int) -> bool:
        """Return whether an HTTPS authority is eligible for a connector-auth binding.

        The compiled admission index contains only APIs whose firewall names, bases,
        and auth mappings are valid, whose bases use HTTPS, and whose auth applies
        ordinary upstream credentials through headers, query parameters, or AWS
        SigV4. HTTP APIs, APIs with ``auth.base`` alone or no ordinary mutation, and
        malformed name, base, or auth inputs are excluded.

        This connection-phase predicate normalizes the host and effective HTTPS port,
        then compares only the authority. Static host authorities, including bases
        parameterized only in their paths, and parameterized hosts participate.
        Explicit and implicit port 443 are equivalent; non-default ports must match
        exactly. Base paths, permission rules, and network policies are deliberately
        not evaluated before an HTTP request exists.

        A match is eligibility for the privileged ``connector_auth`` binding, not
        request authorization. Request handling later evaluates full base/path,
        connector-owner, permission/rule, and network-policy decisions. Before it
        mutates a request, ordinary credential handling still requires the current
        direct binding and applicable public-destination and host-policy guards.

        Contract coverage lives in
        ``tests/test_compiled_firewall_authority_normalization.py`` and
        ``tests/test_server_connect_hook.py``.
        """
        url_parts = _split_https_authority_parts(host, port)
        if url_parts is None:
            return False
        authority_index = self._ordinary_credential_authority_index
        if url_parts.authority.lower() in authority_index.static_authorities:
            return True
        return any(
            _match_compiled_base_authority(url_parts, base)
            for base in authority_index.parameterized_bases
        )


UnknownPolicy = Literal["allow", "deny", "ask"]


class _CompiledNetworkPolicy(NamedTuple):
    blocked_permissions: frozenset[str]
    unknown_policy: UnknownPolicy
    permission_malformed: bool
    unknown_policy_malformed: bool


class CompiledNetworkPolicies(NamedTuple):
    policies: Mapping[str, _CompiledNetworkPolicy]
    top_level_malformed: bool


class _CompiledRuleCandidate(NamedTuple):
    permission: str
    rule: str
    specificity: _PathSpecificity
    params: dict[str, str]


def _is_string_record(value: object) -> bool:
    return isinstance(value, dict) and all(
        isinstance(key, str) and isinstance(record_value, str)
        for key, record_value in value.items()
    )


class _AuthBaseStaticValidationTarget(NamedTuple):
    url: str | None
    dynamic_prefix_suffix: str


def _auth_base_with_reference_placeholders(
    auth_base: str,
    references: tuple[connector_template_syntax.SimpleTemplateReference, ...],
    *,
    start: int,
) -> str:
    parts: list[str] = []
    last_index = start
    for reference in references:
        parts.append(auth_base[last_index : reference.start])
        parts.append(_AUTH_TEMPLATE_URL_PLACEHOLDER)
        last_index = reference.end
    parts.append(auth_base[last_index:])
    return "".join(parts)


def _auth_base_for_static_url_validation(auth_base: str) -> _AuthBaseStaticValidationTarget:
    if _AUTH_TEMPLATE_START not in auth_base:
        return _AuthBaseStaticValidationTarget(auth_base, "")

    references = tuple(connector_template_syntax.iter_simple_references(auth_base))
    replaced = _auth_base_with_reference_placeholders(auth_base, references, start=0)
    if _AUTH_TEMPLATE_START in replaced:
        return _AuthBaseStaticValidationTarget(auth_base, "")
    if references and references[0].start == 0:
        suffix = _auth_base_with_reference_placeholders(
            auth_base,
            references[1:],
            start=references[0].end,
        )
        return _AuthBaseStaticValidationTarget(None, suffix)
    return _AuthBaseStaticValidationTarget(replaced, "")


def _dynamic_auth_base_suffix_is_valid(suffix: str) -> bool:
    if (
        _AUTH_TEMPLATE_START in suffix
        or has_unsafe_url_codepoint(suffix)
        or has_raw_whitespace(suffix)
        or "#" in suffix
        or (suffix != "" and not suffix.startswith(("/", "?")))
    ):
        return False
    if not suffix.startswith("/"):
        return True
    suffix_path = suffix.partition("?")[0]
    return not has_unsafe_path(suffix_path)


def _static_auth_base_is_valid(auth_base: str) -> bool:
    if "\\" in auth_base:
        return False
    target = _auth_base_for_static_url_validation(auth_base)
    if not _dynamic_auth_base_suffix_is_valid(target.dynamic_prefix_suffix):
        return False
    validation_url = target.url
    if validation_url is None:
        return True
    if _AUTH_TEMPLATE_START in validation_url:
        return False
    if has_raw_whitespace(validation_url):
        return False
    if "://" not in validation_url:
        return False

    try:
        parts = urlsplit(validation_url)
    except ValueError:
        return False
    if parts.scheme.lower() != _VALID_AUTH_BASE_SCHEME:
        return False
    if parts.fragment:
        return False
    if has_unsafe_path(parts.path):
        return False
    return (
        _split_base_match_url(
            validation_url,
            allow_query_fragment=True,
            allow_malformed_authority=False,
        )
        is not None
    )


def _auth_config_is_valid(api_entry: dict) -> bool:
    if "auth" not in api_entry:
        return False

    raw_auth = api_entry["auth"]
    if not isinstance(raw_auth, dict):
        return False

    if "headers" in raw_auth and not _is_string_record(raw_auth["headers"]):
        return False
    if "query" in raw_auth and not _is_string_record(raw_auth["query"]):
        return False
    if "awsSigv4" in raw_auth:
        raw_aws_sigv4 = raw_auth["awsSigv4"]
        if not isinstance(raw_aws_sigv4, dict):
            return False
        if set(raw_aws_sigv4) - {"accessKeyId", "secretAccessKey", "sessionToken"}:
            return False
        if not isinstance(raw_aws_sigv4.get("accessKeyId"), str):
            return False
        if not raw_aws_sigv4["accessKeyId"]:
            return False
        if not isinstance(raw_aws_sigv4.get("secretAccessKey"), str):
            return False
        if not raw_aws_sigv4["secretAccessKey"]:
            return False
        if "sessionToken" in raw_aws_sigv4:
            optional_value = raw_aws_sigv4["sessionToken"]
            if not isinstance(optional_value, str):
                return False
            if not optional_value:
                return False
        if raw_auth.get("headers"):
            return False
        if raw_auth.get("query"):
            return False
        if "base" in raw_auth:
            return False
    if "base" in raw_auth and not isinstance(raw_auth["base"], str):
        return False
    return "base" not in raw_auth or _static_auth_base_is_valid(raw_auth["base"])


def _api_routing_identity(api_entry: dict) -> str | None:
    identity = {
        "base": api_entry.get("base"),
        "auth": api_entry.get("auth"),
    }
    if "hostPolicy" in api_entry:
        identity["hostPolicy"] = api_entry["hostPolicy"]
    try:
        return json.dumps(
            identity,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError):
        return None


def firewall_api_auth_config_is_valid(api_entry: dict) -> bool:
    """Return whether an API entry auth config has a valid runtime shape."""
    return _auth_config_is_valid(api_entry)


def _path_specificity(
    pattern: CompiledPathPattern,
) -> _PathSpecificity:
    literal_segments = 0
    mixed_param_segments = 0
    plain_param_segments = 0
    plus_greedy_segments = 0
    star_greedy_segments = 0
    literal_chars = 0

    for segment in pattern.segments:
        if isinstance(segment, SegmentLiteral):
            literal_segments += 1
            literal_chars += len(segment.value)
            continue
        if isinstance(segment, SegmentError):
            continue

        literal_chars += len(segment.prefix) + len(segment.suffix)
        if segment.prefix or segment.suffix:
            mixed_param_segments += 1
        elif segment.greedy == "+":
            plus_greedy_segments += 1
        elif segment.greedy == "*":
            star_greedy_segments += 1
        else:
            plain_param_segments += 1

    return (
        literal_segments,
        mixed_param_segments,
        plain_param_segments,
        plus_greedy_segments,
        -star_greedy_segments,
        literal_chars,
        len(pattern.segments),
    )


def _compiled_base_authority_has_params(base: _CompiledBase) -> bool:
    return base.has_params and any(
        not isinstance(segment, SegmentLiteral) for segment in base.host_segments
    )


def _compile_ordinary_credential_authority_index(
    firewalls: tuple[_CompiledFirewall, ...],
) -> _CompiledOrdinaryCredentialAuthorityIndex:
    static_authorities: set[str] = set()
    parameterized_bases: list[_CompiledBase] = []
    for firewall in firewalls:
        if firewall.name_malformed:
            continue
        for api in firewall.apis:
            if (
                api.base_malformed
                or not api.injects_ordinary_upstream_credentials
                or api.base.parts.scheme.lower() != "https"
            ):
                continue
            if _compiled_base_authority_has_params(api.base):
                parameterized_bases.append(api.base)
            else:
                static_authorities.add(api.base.parts.authority.lower())
    return _CompiledOrdinaryCredentialAuthorityIndex(
        frozenset(static_authorities),
        tuple(parameterized_bases),
    )


def _path_index_key(path: str) -> tuple[str, ...]:
    return tuple(_split_path_segments(path))


def _static_api_index_key(
    base: _CompiledBase,
) -> tuple[str, str, tuple[str, ...]] | None:
    if (
        base.has_params
        or base.raw_syntax_malformed
        or base.param_parse_malformed
        or base.parts.host_malformed
        or base.parts.has_userinfo
        or base.parts.port_malformed
    ):
        return None
    return (
        base.parts.scheme.lower(),
        base.parts.authority.lower(),
        _path_index_key(base.parts.path),
    )


def _insert_prefix_trie_value[T](
    root: _PrefixTrieBuilder[T],
    path_key: tuple[str, ...],
    value: T,
) -> None:
    node = root
    for segment in path_key:
        node = node.children.setdefault(segment, _PrefixTrieBuilder())
    node.values.append(value)


def _freeze_prefix_trie[T](
    builder: _PrefixTrieBuilder[T],
) -> _CompiledPrefixTrieNode[T]:
    frozen_nodes: dict[int, _CompiledPrefixTrieNode[T]] = {}
    stack: list[tuple[_PrefixTrieBuilder[T], bool]] = [(builder, False)]
    while stack:
        node, visited = stack.pop()
        if visited:
            frozen_nodes[id(node)] = _CompiledPrefixTrieNode(
                tuple(node.values),
                MappingProxyType(
                    {segment: frozen_nodes[id(child)] for segment, child in node.children.items()}
                ),
            )
            continue
        stack.append((node, True))
        stack.extend((child, False) for child in node.children.values())
    return frozen_nodes[id(builder)]


def _visit_prefix_trie_values[T](
    root: _CompiledPrefixTrieNode[T],
    path_segs: Iterable[str],
    visit_values: Callable[[tuple[T, ...]], None],
) -> None:
    visit_values(root.values)
    node = root
    path_iter = iter(path_segs)
    while node.children:
        try:
            segment = next(path_iter)
        except StopIteration:
            break
        child = node.children.get(segment)
        if child is None:
            break
        node = child
        visit_values(node.values)


def _compile_api_candidate_index(
    firewalls: tuple[_CompiledFirewall, ...],
) -> _CompiledApiIndex:
    all_candidates: list[_CompiledApiCandidate] = []
    fallback: list[_CompiledApiCandidate] = []
    static_roots: dict[
        tuple[str, str],
        _PrefixTrieBuilder[_CompiledApiCandidate],
    ] = {}

    order = 0
    for firewall in firewalls:
        for api in firewall.apis:
            candidate = _CompiledApiCandidate(order, firewall, api)
            all_candidates.append(candidate)
            key = _static_api_index_key(api.base)
            if key is None:
                fallback.append(candidate)
            else:
                scheme, authority, path_key = key
                root = static_roots.setdefault((scheme, authority), _PrefixTrieBuilder())
                _insert_prefix_trie_value(root, path_key, candidate)
            order += 1

    return _CompiledApiIndex(
        tuple(all_candidates),
        tuple(fallback),
        MappingProxyType({key: _freeze_prefix_trie(root) for key, root in static_roots.items()}),
    )


def _indexed_api_candidates(
    api_index: _CompiledApiIndex,
    url_parts: _BaseUrlParts,
) -> tuple[_CompiledApiCandidate, ...]:
    candidates = list(api_index.fallback)
    root = api_index.static_roots.get((url_parts.scheme.lower(), url_parts.authority.lower()))
    if root is not None:
        _visit_prefix_trie_values(
            root,
            _iter_path_segments(url_parts.path),
            candidates.extend,
        )
    if len(candidates) <= 1:
        return tuple(candidates)
    return tuple(sorted(candidates, key=lambda candidate: candidate.order))


def _rule_path_index_key(rule: _CompiledRule) -> tuple[str, ...] | None:
    prefix: list[str] = []
    for segment in rule.path.segments:
        if not isinstance(segment, SegmentLiteral):
            break
        prefix.append(segment.value)
    return tuple(prefix) if prefix else None


def _add_rule_entries(
    candidates: list[_CompiledRuleEntry],
    seen_orders: set[int],
    entries: tuple[_CompiledRuleEntry, ...],
) -> None:
    for entry in entries:
        if entry.order not in seen_orders:
            seen_orders.add(entry.order)
            candidates.append(entry)


def _compile_rule_method_index(
    entries: list[_CompiledRuleEntry],
) -> _CompiledRuleMethodIndex:
    fallback: list[_CompiledRuleEntry] = []
    prefix_root = _PrefixTrieBuilder[_CompiledRuleEntry]()
    for entry in entries:
        key = _rule_path_index_key(entry.rule)
        if key is None:
            fallback.append(entry)
        else:
            _insert_prefix_trie_value(prefix_root, key, entry)
    return _CompiledRuleMethodIndex(
        tuple(fallback),
        _freeze_prefix_trie(prefix_root),
    )


def _compile_rule_index(
    permissions: tuple[_CompiledPermission, ...],
) -> _CompiledRuleIndex:
    all_rules: list[_CompiledRuleEntry] = []
    by_method_entries: dict[str, list[_CompiledRuleEntry]] = {}

    order = 0
    for permission in permissions:
        for rule in permission.rules:
            entry = _CompiledRuleEntry(order, permission.name, rule)
            all_rules.append(entry)
            by_method_entries.setdefault(rule.method, []).append(entry)
            order += 1

    return _CompiledRuleIndex(
        tuple(all_rules),
        MappingProxyType(
            {
                method: _compile_rule_method_index(entries)
                for method, entries in by_method_entries.items()
            }
        ),
    )


def _indexed_rule_candidates(
    api_entry: _CompiledApi,
    upper_method: str,
    rel_path_segs: list[str],
) -> tuple[_CompiledRuleEntry, ...]:
    candidates: list[_CompiledRuleEntry] = []
    seen_orders: set[int] = set()

    def add_entries(entries: tuple[_CompiledRuleEntry, ...]) -> None:
        _add_rule_entries(candidates, seen_orders, entries)

    def add_method_candidates(method: str) -> None:
        method_index = api_entry.rule_index.by_method.get(method)
        if method_index is None:
            return
        add_entries(method_index.fallback)
        _visit_prefix_trie_values(
            method_index.prefix_root,
            rel_path_segs,
            add_entries,
        )

    add_method_candidates("ANY")
    if upper_method != "ANY":
        add_method_candidates(upper_method)

    if len(candidates) <= 1:
        return tuple(candidates)
    return tuple(sorted(candidates, key=lambda entry: entry.order))


def _compile_rule(rule_str: str) -> _CompiledRule | None:
    parts = rule_str.split(" ", 1)
    if len(parts) != _RULE_TOKEN_COUNT:
        return None
    method, path = parts
    if method not in _VALID_RULE_METHODS:
        return None
    if (
        not path.startswith("/")
        or "?" in path
        or "#" in path
        or "\\" in path
        or has_unsafe_url_codepoint(path)
        or has_raw_whitespace(path)
    ):
        return None
    pattern = compile_path_pattern(path)
    if pattern is None:
        return None
    if not _compiled_rule_path_is_valid(pattern):
        return None
    return _CompiledRule(method, rule_str, pattern, _path_specificity(pattern))


def firewall_rule_is_valid(rule_str: str) -> bool:
    """Return whether a firewall permission rule matches the runtime grammar."""
    return _compile_rule(rule_str) is not None


DeclaredFirewallPermissionNameInvalidReason = Literal["empty", "reserved"]


def declared_firewall_permission_name_invalid_reason(
    name: str,
) -> DeclaredFirewallPermissionNameInvalidReason | None:
    """Return why a declared permission name is invalid, or ``None`` when valid.

    This validates permission definitions only. Network-policy grant storage may
    use ``__unknown__`` as the unknown-endpoint sentinel.
    """
    if name == "":
        return "empty"
    if name in _RESERVED_DECLARED_FIREWALL_PERMISSION_NAMES:
        return "reserved"
    return None


# Compiled matcher contract
#
# Registry loading stores these compiled objects and request handling later
# converts FirewallBlock into a 403, so the compile phase deliberately
# distinguishes inputs that cannot match from malformed inputs that can still
# match a base and must fail closed at match time.
#
# Registry loading rejects explicit non-null, non-list firewalls payloads for
# registered sandboxes before request handling. Direct compile_firewalls callers still
# get None for missing, empty, or non-list payloads. compile_firewalls skips raw
# entries that cannot participate in base matching: non-object firewall entries,
# firewalls whose "apis" is not a list, non-object APIs, non-string bases, bases
# that cannot compile into matcher data, and firewalls with no compiled APIs.
# Once an API base compiles, the API is retained and records malformed state for:
# firewall name, base syntax/authority/params, auth config, and permission/rule
# config.
#
# compile_network_policies preserves malformed policy state for a present
# non-object top-level networkPolicies payload, non-object per-firewall grants,
# malformed allow/deny/ask permission sets, and malformed unknownPolicy. It
# skips non-string policy keys because they cannot address a firewall name.
#
# match_compiled_firewall_request applies retained malformed state only after a
# request matches a compiled base. The relevant fail-closed reasons are
# "malformed_firewall_config", "malformed_network_policy", and "unsafe_path".
# Malformed config for an unrelated base does not block unrelated traffic.
#
# Preserve current decision precedence when changing this code or these docs:
# unsafe paths block immediately after base match. APIs with malformed firewall
# name, base, or auth config record malformed firewall config and then skip rule
# evaluation for that API. Malformed permission/rule config records malformed
# firewall config but still lets valid compiled rules on that API participate.
# Malformed top-level policies or malformed allow/deny/ask permission sets record
# malformed network policy and skip rule evaluation for the matched API.
# Recorded allow/deny rule decisions resolve before retained malformed state; if
# no allow/deny resolved, malformed network policy resolves before malformed
# firewall config; malformed unknownPolicy only affects unknown-endpoint
# resolution.
#
# Path-rule specificity is applied after the best matching base specificity has selected the API
# tier. The tuple documented above is compared lexicographically, and only rules with the highest
# matching tuple are evaluated. APIs and rules tied at that tuple remain candidates for the later
# connector-owner and network-policy reduction; equal-specificity candidates are not discarded
# during specificity selection. The focused contract is covered by
# ``tests/test_compiled_firewall_rule_specificity_precedence.py``,
# ``tests/test_compiled_firewall_cross_firewall_precedence.py``, and the parity cases in
# ``turbo/packages/connectors/src/__tests__/firewall-rule-matcher.test.ts``.
def compile_firewall_core(fw_entry: object) -> CompiledFirewallCore | None:
    """Compile one firewall into reusable matcher data.

    The core retains the firewall name and, for each compilable raw API, its original list index
    plus matcher-relevant ``base``, ``auth``, optional ``hostPolicy``, permissions, rules, ordering,
    and malformed state. The original index lets ``bind_compiled_firewall_core`` attach a later raw
    API shell without recompiling this data.

    Return ``None`` when the firewall is not a dictionary, ``apis`` is not a list, or no API has a
    compilable string base. Other selected malformed inputs are retained according to the compiled
    matcher contract above. A caller that reuses this core with another firewall dictionary must
    satisfy the compatibility contract documented by ``bind_compiled_firewall_core``.
    """
    if not isinstance(fw_entry, dict):
        return None

    raw_name = fw_entry.get("name")
    name_malformed = not isinstance(raw_name, str) or raw_name == ""
    firewall_name = raw_name if isinstance(raw_name, str) else ""
    raw_custom_connector_id = fw_entry.get("customConnectorId")
    intent_identity = (
        raw_custom_connector_id
        if isinstance(raw_custom_connector_id, str) and raw_custom_connector_id != ""
        else firewall_name
    )

    raw_apis = fw_entry.get("apis", [])
    if not isinstance(raw_apis, list):
        return None

    api_cores: list[_CompiledApiCore] = []
    for api_index, api_entry in enumerate(raw_apis):
        if not isinstance(api_entry, dict):
            continue
        raw_base = api_entry.get("base", "")
        if not isinstance(raw_base, str):
            continue
        compiled_config_base = _compile_firewall_config_base(raw_base)
        if compiled_config_base is None:
            continue
        base = compiled_config_base.base
        base_malformed = compiled_config_base.malformed
        auth_malformed = not _auth_config_is_valid(api_entry)
        injects_ordinary_upstream_credentials = (
            not auth_malformed
            and auth_config_injects_ordinary_upstream_credentials(api_entry.get("auth"))
        )
        routing_identity = _api_routing_identity(api_entry)

        compiled_permissions: list[_CompiledPermission] = []
        has_malformed_rules = name_malformed
        seen_permission_names: set[str] = set()
        permissions = api_entry.get("permissions")
        permissions_present = "permissions" in api_entry
        permissionless = not permissions_present or (
            isinstance(permissions, list) and len(permissions) == 0
        )
        if isinstance(permissions, list):
            for perm in permissions:
                if not isinstance(perm, dict):
                    has_malformed_rules = True
                    continue
                raw_name = perm.get("name")
                if not isinstance(raw_name, str):
                    has_malformed_rules = True
                    continue
                if declared_firewall_permission_name_invalid_reason(raw_name) is not None:
                    has_malformed_rules = True
                    continue
                if raw_name in seen_permission_names:
                    has_malformed_rules = True
                    continue
                seen_permission_names.add(raw_name)
                raw_rules = perm.get("rules", [])
                if not isinstance(raw_rules, list):
                    raw_rules = []
                    has_malformed_rules = True
                if len(raw_rules) == 0:
                    has_malformed_rules = True

                compiled_rules: list[_CompiledRule] = []
                for rule_str in raw_rules:
                    if not isinstance(rule_str, str):
                        has_malformed_rules = True
                        continue
                    rule = _compile_rule(rule_str)
                    if rule is None:
                        has_malformed_rules = True
                        continue
                    compiled_rules.append(rule)

                compiled_permissions.append(_CompiledPermission(raw_name, tuple(compiled_rules)))
        elif permissions_present:
            has_malformed_rules = True

        compiled_permissions_tuple = tuple(compiled_permissions)
        api_cores.append(
            _CompiledApiCore(
                api_index,
                base,
                compiled_permissions_tuple,
                _compile_rule_index(compiled_permissions_tuple),
                base_malformed,
                auth_malformed,
                injects_ordinary_upstream_credentials,
                permissionless,
                routing_identity,
                has_malformed_rules,
            )
        )

    if not api_cores:
        return None
    return CompiledFirewallCore(
        firewall_name,
        intent_identity,
        tuple(api_cores),
        name_malformed,
    )


def bind_compiled_firewall_core(
    fw_entry: dict,
    core: CompiledFirewallCore,
) -> _CompiledFirewall | None:
    """Bind compatible raw API shell entries to reusable compiled firewall data.

    ``fw_entry`` must describe the same matcher definition that produced ``core``. Its firewall
    name and raw ``apis`` positional structure must be unchanged, including which entries compile.
    At every retained position, ``base``, ``auth``, optional ``hostPolicy``, permissions, permission
    names, rules, and their ordering must have the same values. Each API core is paired with the raw
    dictionary at its original ``raw_api_index``; reordering or replacing entries is incompatible
    even when the target list still has a dictionary at that index.

    Fields excluded from core compilation may remain shell-local. Builtin reuse currently rebinds
    generated API ``id`` values, snapshot-owned ``_builtinHostPolicyRuntime`` metadata, and the
    registry-owned connector candidate kind. Such raw fields remain subject to their own validity
    and lifecycle contracts; in particular, runtime host-policy metadata must stay paired with the
    target shell's resolved registry snapshot.

    The caller or its cache key must enforce this compatibility before reuse. This function does
    not compare semantic content. It returns ``None`` only when the target ``apis`` value is not a
    list, a retained index is unavailable or does not contain a dictionary, or no APIs are bound;
    that result is a structural failure, not a semantic compatibility verdict.
    """
    raw_apis = fw_entry.get("apis", [])
    if not isinstance(raw_apis, list):
        return None

    compiled_apis: list[_CompiledApi] = []
    for api_core in core.api_cores:
        if api_core.raw_api_index >= len(raw_apis):
            return None
        api_entry = raw_apis[api_core.raw_api_index]
        if not isinstance(api_entry, dict):
            return None
        compiled_apis.append(_CompiledApi(api_entry, api_core))

    if not compiled_apis:
        return None
    return _CompiledFirewall(
        core,
        tuple(compiled_apis),
        connector_runtime_metadata.connector_runtime_kind(fw_entry),
    )


def compile_firewalls(sandbox_firewalls: object | None) -> CompiledFirewallSet | None:
    """Compile firewall data and retain selected malformed state.

    See the compiled matcher contract above for skipped versus retained inputs.
    """
    if not isinstance(sandbox_firewalls, list) or not sandbox_firewalls:
        return None

    compiled_firewalls: list[_CompiledFirewall] = []
    for fw_entry in sandbox_firewalls:
        core = compile_firewall_core(fw_entry)
        if core is None or not isinstance(fw_entry, dict):
            continue
        compiled_firewall = bind_compiled_firewall_core(fw_entry, core)
        if compiled_firewall is not None:
            compiled_firewalls.append(compiled_firewall)

    if not compiled_firewalls:
        return None
    return CompiledFirewallSet(tuple(compiled_firewalls))


def _compile_permission_set(raw_value: object | None) -> tuple[frozenset[str], bool]:
    if raw_value is None:
        return frozenset(), False
    if not isinstance(raw_value, list):
        return frozenset(), True
    if not all(isinstance(item, str) for item in raw_value):
        return frozenset(), True
    return frozenset(raw_value), False


def compile_network_policies(raw_network_policies: object | None) -> CompiledNetworkPolicies:
    """Compile networkPolicies and retain selected malformed policy state.

    See the compiled matcher contract above for match-time fail-closed semantics.
    """
    if raw_network_policies is None:
        return CompiledNetworkPolicies(MappingProxyType({}), False)
    if not isinstance(raw_network_policies, dict):
        return CompiledNetworkPolicies(MappingProxyType({}), True)

    compiled: dict[str, _CompiledNetworkPolicy] = {}
    for fw_name, grant in raw_network_policies.items():
        if not isinstance(fw_name, str):
            continue

        if not isinstance(grant, dict):
            compiled[fw_name] = _CompiledNetworkPolicy(
                frozenset(),
                "allow",
                True,
                False,
            )
            continue

        _allow, allow_malformed = _compile_permission_set(grant.get("allow"))
        deny, deny_malformed = _compile_permission_set(grant.get("deny"))
        ask, ask_malformed = _compile_permission_set(grant.get("ask"))

        raw_unknown_policy = grant.get("unknownPolicy")
        unknown_policy: UnknownPolicy = "allow"
        unknown_policy_malformed = False
        if raw_unknown_policy is None:
            unknown_policy = "allow"
        elif raw_unknown_policy in ("allow", "deny", "ask"):
            unknown_policy = raw_unknown_policy
        else:
            unknown_policy_malformed = True

        compiled[fw_name] = _CompiledNetworkPolicy(
            deny | ask,
            unknown_policy,
            allow_malformed or deny_malformed or ask_malformed,
            unknown_policy_malformed,
        )

    return CompiledNetworkPolicies(MappingProxyType(compiled), False)


def _ensure_compiled_network_policies(
    network_policies: object | None,
) -> CompiledNetworkPolicies:
    if isinstance(network_policies, CompiledNetworkPolicies):
        return network_policies
    return compile_network_policies(network_policies)


class FirewallAllow(NamedTuple):
    """Matched-firewall allow decision for connector auth handling.

    Depending on the auth configuration, handling may inject headers or query
    parameters, rewrite and forward through ``auth.base``, apply AWS SigV4
    signing, or make no credential changes. Asterisk-form allows that proceed
    without auth are represented by ``FirewallPolicyAllow`` instead.

    ``permission`` and ``rule`` are present for a matched permission. They are
    ``None`` for unknown-endpoint allow, where the firewall base matched but no
    permission rule did and ``unknownPolicy`` allowed the request.
    """

    api_entry: dict
    name: str
    permission: str | None
    params: dict[str, str]
    rule: str | None
    rel_path: str


class FirewallPolicyAllow(NamedTuple):
    """Asterisk-form base matched and unknown policy allowed without auth."""

    firewall_allow: FirewallAllow


def _permission_allow(
    api_entry: dict,
    *,
    name: str,
    permission: str,
    params: dict[str, str],
    rule: str,
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, permission, params, rule, rel_path)


def _unknown_allow(
    api_entry: dict,
    *,
    name: str,
    params: dict[str, str],
    rel_path: str,
) -> FirewallAllow:
    return FirewallAllow(api_entry, name, None, params, None, rel_path)


FirewallBlockReason = Literal[
    "permission_denied",
    "unknown_endpoint",
    "malformed_firewall_config",
    "malformed_network_policy",
    "unsafe_path",
]


class FirewallBlock(NamedTuple):
    """Base URL matched but the request should return 403."""

    base: str
    name: str
    method: str
    path: str
    permissions: tuple[str, ...]  # denied/asked permission names only
    reason: FirewallBlockReason


ConnectorRouteAmbiguityReason = Literal[
    "connector_intent_required",
    "malformed_connector_intent",
    "connector_intent_not_candidate",
]


class FirewallAmbiguous(NamedTuple):
    """Multiple connector owners matched and no usable intent selected one."""

    method: str
    path: str
    candidates: tuple[str, ...]
    reason: ConnectorRouteAmbiguityReason


class _BaseMatch(NamedTuple):
    base: str
    name: str
    rel_path: str
    api_entry: dict
    params: dict[str, str]


class _AllowedRuleMatch(NamedTuple):
    api_entry: dict
    name: str
    rel_path: str
    candidate: _CompiledRuleCandidate


class _BlockMatch(NamedTuple):
    base: str
    name: str
    method: str
    rel_path: str


class _MatchedApi(NamedTuple):
    order: int
    firewall: _CompiledFirewall
    api: _CompiledApi
    rel_path: str
    base_params: dict[str, str]
    block_match: _BlockMatch


class _FirewallMatchCollection:
    """Winning base matches and rule-route summary collected before policy evaluation."""

    __slots__ = (
        "api_matches",
        "best_base_specificity",
        "best_rule_specificity",
        "winning_rule_api_orders",
    )

    api_matches: list[_MatchedApi]
    best_base_specificity: _BaseSpecificity | None
    best_rule_specificity: _PathSpecificity | None
    winning_rule_api_orders: set[int]

    def __init__(self) -> None:
        self.api_matches = []
        self.best_base_specificity = None
        self.best_rule_specificity = None
        self.winning_rule_api_orders = set()

    def accept_api(self, match: _MatchedApi) -> bool:
        specificity = match.api.base.specificity
        if self.best_base_specificity is None or specificity > self.best_base_specificity:
            self.best_base_specificity = specificity
            self.best_rule_specificity = None
            self.api_matches = []
            self.winning_rule_api_orders = set()
        elif specificity < self.best_base_specificity:
            return False

        self.api_matches.append(match)
        return True

    def can_rule_affect_collection(self, specificity: _PathSpecificity) -> bool:
        return self.best_rule_specificity is None or specificity >= self.best_rule_specificity

    def record_rule_route(self, api_order: int, specificity: _PathSpecificity) -> None:
        if self.best_rule_specificity is None or specificity > self.best_rule_specificity:
            self.best_rule_specificity = specificity
            self.winning_rule_api_orders = set()
        elif specificity < self.best_rule_specificity:
            return
        self.winning_rule_api_orders.add(api_order)


class _FirewallDecisionState:
    """Policy reduction state initialized with the preselected base fallback."""

    __slots__ = (
        "allowed_match",
        "base_match",
        "denied_match",
        "denied_permission_names",
        "malformed_config_match",
        "malformed_policy_match",
    )

    allowed_match: _AllowedRuleMatch | None
    base_match: _BaseMatch | None
    denied_match: _BlockMatch | None
    # Dict keys act as an ordered set of first-seen denied permission names.
    denied_permission_names: dict[str, None]
    malformed_config_match: _BlockMatch | None
    malformed_policy_match: _BlockMatch | None

    def __init__(self, base_match: _BaseMatch | None) -> None:
        self.allowed_match = None
        self.base_match = base_match
        self.denied_match = None
        self.denied_permission_names = {}
        self.malformed_config_match = None
        self.malformed_policy_match = None

    def record_malformed_config(self, match: _BlockMatch) -> None:
        if self.malformed_config_match is None:
            self.malformed_config_match = match

    def record_malformed_policy(self, match: _BlockMatch) -> None:
        if self.malformed_policy_match is None:
            self.malformed_policy_match = match

    def record_allowed_rule(self, match: _AllowedRuleMatch) -> None:
        if self.allowed_match is None:
            self.allowed_match = match

    def record_denied_rule(self, match: _BlockMatch, permission: str) -> None:
        self.denied_permission_names[permission] = None
        if self.denied_match is None:
            self.denied_match = match


def _resolve_firewall_decision(
    state: _FirewallDecisionState,
    *,
    compiled_network_policies: CompiledNetworkPolicies,
    upper_method: str,
) -> FirewallAllow | FirewallBlock | None:
    base_match = state.base_match
    if base_match is None:
        return None

    if state.allowed_match is not None:
        allowed_match = state.allowed_match
        candidate = allowed_match.candidate
        return _permission_allow(
            allowed_match.api_entry,
            name=allowed_match.name,
            permission=candidate.permission,
            params=candidate.params,
            rule=candidate.rule,
            rel_path=allowed_match.rel_path,
        )
    if state.denied_match is not None:
        denied_match = state.denied_match
        return FirewallBlock(
            denied_match.base,
            denied_match.name,
            denied_match.method,
            denied_match.rel_path,
            tuple(state.denied_permission_names),
            "permission_denied",
        )
    if state.malformed_policy_match is not None:
        match = state.malformed_policy_match
        return FirewallBlock(
            match.base,
            match.name,
            match.method,
            match.rel_path,
            (),
            "malformed_network_policy",
        )
    if state.malformed_config_match is not None:
        match = state.malformed_config_match
        return FirewallBlock(
            match.base,
            match.name,
            match.method,
            match.rel_path,
            (),
            "malformed_firewall_config",
        )

    blocked_policy = compiled_network_policies.policies.get(base_match.name)
    if blocked_policy is None:
        return _unknown_allow(
            base_match.api_entry,
            name=base_match.name,
            params=base_match.params,
            rel_path=base_match.rel_path,
        )
    if blocked_policy.unknown_policy_malformed:
        return FirewallBlock(
            base_match.base,
            base_match.name,
            upper_method,
            base_match.rel_path,
            (),
            "malformed_network_policy",
        )
    if blocked_policy.unknown_policy == "allow":
        return _unknown_allow(
            base_match.api_entry,
            name=base_match.name,
            params=base_match.params,
            rel_path=base_match.rel_path,
        )
    return FirewallBlock(
        base_match.base,
        base_match.name,
        upper_method,
        base_match.rel_path,
        (),
        "unknown_endpoint",
    )


def _collect_rule_routes(
    *,
    collection: _FirewallMatchCollection,
    api_match: _MatchedApi,
    rel_path_segs: list[str],
    upper_method: str,
    rule_entries: tuple[_CompiledRuleEntry, ...],
) -> None:
    for entry in rule_entries:
        rule = entry.rule
        if rule.method not in ("ANY", upper_method):
            continue
        if not collection.can_rule_affect_collection(rule.specificity):
            continue

        if not _compiled_path_segments_match(rel_path_segs, rule.path.segments):
            continue
        collection.record_rule_route(api_match.order, rule.specificity)


def _winning_api_matches(
    collection: _FirewallMatchCollection,
) -> tuple[_MatchedApi, ...]:
    if collection.best_rule_specificity is None:
        return tuple(collection.api_matches)
    return tuple(
        match
        for match in collection.api_matches
        if match.order in collection.winning_rule_api_orders
    )


def _winning_owner_names(collection: _FirewallMatchCollection) -> tuple[str, ...]:
    matches = _winning_api_matches(collection)
    names = {match.firewall.name for match in matches if not match.firewall.name_malformed}
    return tuple(sorted(names))


def _owner_name_for_intent(
    collection: _FirewallMatchCollection,
    intent_value: str,
) -> str | None:
    matching_names = {
        match.firewall.name
        for match in _winning_api_matches(collection)
        if not match.firewall.name_malformed and match.firewall.intent_identity == intent_value
    }
    if len(matching_names) != 1:
        return None
    return next(iter(matching_names))


def _ambiguity_reason(
    intent: connector_intent.ConnectorIntent,
) -> ConnectorRouteAmbiguityReason:
    if intent.status == "absent":
        return "connector_intent_required"
    if intent.status == "malformed":
        return "malformed_connector_intent"
    return "connector_intent_not_candidate"


def _selected_owner_name(
    collection: _FirewallMatchCollection,
    intent: connector_intent.ConnectorIntent,
    *,
    upper_method: str,
    path: str,
) -> str | FirewallAmbiguous | None:
    owners = _winning_owner_names(collection)
    if len(owners) == 0:
        return None
    if len(owners) == 1 and intent.status == "absent":
        return owners[0]
    if intent.status == "present" and intent.value is not None:
        selected_name = _owner_name_for_intent(collection, intent.value)
        if selected_name is not None:
            return selected_name
    return FirewallAmbiguous(
        upper_method,
        path,
        owners,
        _ambiguity_reason(intent),
    )


def _selected_source_api_matches(
    collection: _FirewallMatchCollection,
    selected_name: str,
) -> list[_MatchedApi]:
    matches = [
        match for match in _winning_api_matches(collection) if match.firewall.name == selected_name
    ]
    if collection.best_rule_specificity is not None:
        return matches

    # APIs without permissions are catch-alls only within the selected owner.
    # Owner selection must still resolve shared bases before this fallback.
    permissionless_matches = [match for match in matches if match.api.permissionless]
    return permissionless_matches or matches


def _relevant_owner_api_matches(
    collection: _FirewallMatchCollection,
    selected_name: str | None,
) -> list[_MatchedApi]:
    if selected_name is None:
        return collection.api_matches
    return [
        match
        for match in collection.api_matches
        if match.firewall.name == selected_name or match.firewall.name_malformed
    ]


def _selected_base_api_matches(
    collection: _FirewallMatchCollection,
    selected_name: str | None,
) -> list[_MatchedApi]:
    relevant_matches = _relevant_owner_api_matches(collection, selected_name)
    if selected_name is None or collection.best_rule_specificity is not None:
        return relevant_matches

    selected_orders = {
        match.order for match in _selected_source_api_matches(collection, selected_name)
    }
    return [match for match in relevant_matches if match.order in selected_orders]


def _conflicting_selected_api_block(
    collection: _FirewallMatchCollection,
    selected_name: str,
) -> FirewallBlock | None:
    matches = [
        match
        for match in _selected_source_api_matches(collection, selected_name)
        if not (
            match.firewall.name_malformed or match.api.base_malformed or match.api.auth_malformed
        )
    ]
    if len(matches) <= 1:
        return None
    first = matches[0]
    first_identity = first.api.routing_identity
    if first_identity is None:
        return FirewallBlock(
            first.api.base.raw,
            selected_name,
            first.block_match.method,
            first.rel_path,
            (),
            "malformed_firewall_config",
        )
    if all(match.api.routing_identity == first_identity for match in matches[1:]):
        return None
    return FirewallBlock(
        first.api.base.raw,
        selected_name,
        first.block_match.method,
        first.rel_path,
        (),
        "malformed_firewall_config",
    )


def _evaluate_selected_rule_entries(
    *,
    decision: _FirewallDecisionState,
    api_match: _MatchedApi,
    policy: _CompiledNetworkPolicy | None,
    rel_path_segs: list[str],
    upper_method: str,
    winning_specificity: _PathSpecificity,
    rule_entries: tuple[_CompiledRuleEntry, ...],
) -> None:
    for entry in rule_entries:
        rule = entry.rule
        if rule.method not in ("ANY", upper_method):
            continue
        if rule.specificity != winning_specificity:
            continue

        permission_blocked = policy is not None and entry.permission in policy.blocked_permissions
        if permission_blocked:
            if not _compiled_path_segments_match(rel_path_segs, rule.path.segments):
                continue
            decision.record_denied_rule(api_match.block_match, entry.permission)
            continue

        params = _match_compiled_path_segments(rel_path_segs, rule.path.segments)
        if params is None:
            continue
        decision.record_allowed_rule(
            _AllowedRuleMatch(
                api_match.api.raw_api_entry,
                api_match.firewall.name,
                api_match.rel_path,
                _CompiledRuleCandidate(
                    entry.permission,
                    rule.raw,
                    rule.specificity,
                    {**api_match.base_params, **params},
                ),
            )
        )
        return


def _reduce_selected_owner(
    collection: _FirewallMatchCollection,
    *,
    selected_name: str | None,
    compiled_network_policies: CompiledNetworkPolicies,
    upper_method: str,
    indexed_rules: bool,
) -> FirewallAllow | FirewallBlock | None:
    if selected_name is not None:
        conflicting_block = _conflicting_selected_api_block(collection, selected_name)
        if conflicting_block is not None:
            return conflicting_block

    # Collection owns base specificity; owner/permissionless filtering preserves
    # that tier's order, so only its first selected fallback is needed here.
    base_match = next(
        (
            _BaseMatch(
                match.api.base.raw,
                match.firewall.name,
                match.rel_path,
                match.api.raw_api_entry,
                match.base_params,
            )
            for match in _selected_base_api_matches(collection, selected_name)
        ),
        None,
    )
    decision = _FirewallDecisionState(base_match)
    evaluable_api_orders: set[int] = set()
    relevant_api_matches = _relevant_owner_api_matches(collection, selected_name)

    for api_match in relevant_api_matches:
        fw_entry = api_match.firewall
        api_entry = api_match.api
        policy = compiled_network_policies.policies.get(fw_entry.name)
        routing_identity_malformed = api_entry.routing_identity is None
        if (
            api_entry.base_malformed
            or api_entry.auth_malformed
            or api_entry.has_malformed_rules
            or routing_identity_malformed
        ):
            decision.record_malformed_config(api_match.block_match)
        if (
            fw_entry.name_malformed
            or api_entry.base_malformed
            or api_entry.auth_malformed
            or routing_identity_malformed
        ):
            continue
        if compiled_network_policies.top_level_malformed or (
            policy is not None and policy.permission_malformed
        ):
            decision.record_malformed_policy(api_match.block_match)
            continue
        evaluable_api_orders.add(api_match.order)

    winning_specificity = collection.best_rule_specificity
    if winning_specificity is None:
        return _resolve_firewall_decision(
            decision,
            compiled_network_policies=compiled_network_policies,
            upper_method=upper_method,
        )

    for api_match in collection.api_matches:
        if decision.allowed_match is not None:
            break
        if api_match.order not in collection.winning_rule_api_orders:
            continue
        if api_match.order not in evaluable_api_orders:
            continue
        fw_entry = api_match.firewall
        policy = compiled_network_policies.policies.get(fw_entry.name)
        rel_path_segs = _split_path_segments(api_match.rel_path)
        rule_entries = (
            _indexed_rule_candidates(api_match.api, upper_method, rel_path_segs)
            if indexed_rules
            else api_match.api.rule_index.all_rules
        )
        _evaluate_selected_rule_entries(
            decision=decision,
            api_match=api_match,
            policy=policy,
            rel_path_segs=rel_path_segs,
            upper_method=upper_method,
            winning_specificity=winning_specificity,
            rule_entries=rule_entries,
        )

    return _resolve_firewall_decision(
        decision,
        compiled_network_policies=compiled_network_policies,
        upper_method=upper_method,
    )


def _match_compiled_firewall_request_with_api_candidates(
    *,
    url_parts: _BaseUrlParts,
    url_has_backslash: bool,
    upper_method: str,
    compiled_network_policies: CompiledNetworkPolicies,
    api_candidates: tuple[_CompiledApiCandidate, ...],
    indexed_rules: bool,
    intent: connector_intent.ConnectorIntent,
    is_asterisk_form: bool,
) -> FirewallAllow | FirewallPolicyAllow | FirewallBlock | FirewallAmbiguous | None:
    collection = _FirewallMatchCollection()
    base_matches: list[_MatchedApi] = []
    unsafe_path: bool | None = False if is_asterisk_form else (True if url_has_backslash else None)
    decision_path = "*" if is_asterisk_form else (url_parts.path or "/")

    for candidate in api_candidates:
        fw_entry = candidate.firewall
        api_entry = candidate.api
        base_result = _match_compiled_base_url_parts(url_parts, api_entry.base)
        if base_result is None:
            continue

        matched_rel_path, base_params = base_result
        rel_path = "*" if is_asterisk_form else matched_rel_path

        if unsafe_path is None:
            unsafe_path = has_unsafe_path(url_parts.path)

        if unsafe_path:
            return FirewallBlock(
                api_entry.base.raw,
                fw_entry.name,
                upper_method,
                rel_path,
                (),
                "unsafe_path",
            )

        block_match = _BlockMatch(
            api_entry.base.raw,
            fw_entry.name,
            upper_method,
            rel_path,
        )
        api_match = _MatchedApi(
            candidate.order,
            fw_entry,
            api_entry,
            rel_path,
            base_params,
            block_match,
        )
        base_matches.append(api_match)

    custom_connector_matches = any(
        match.firewall.connector_runtime_kind == "custom" for match in base_matches
    )
    explicit_builtin_owner_matches = intent.status == "present" and any(
        match.firewall.connector_runtime_kind == "builtin"
        and not match.firewall.name_malformed
        and match.firewall.intent_identity == intent.value
        for match in base_matches
    )
    for api_match in base_matches:
        if (
            not explicit_builtin_owner_matches
            and custom_connector_matches
            and api_match.firewall.connector_runtime_kind == "builtin"
        ):
            continue
        if not collection.accept_api(api_match):
            continue

        if is_asterisk_form or not api_match.api.permissions:
            continue

        rel_path_segs = _split_path_segments(api_match.rel_path)
        rule_entries = (
            _indexed_rule_candidates(api_match.api, upper_method, rel_path_segs)
            if indexed_rules
            else api_match.api.rule_index.all_rules
        )
        _collect_rule_routes(
            collection=collection,
            api_match=api_match,
            rel_path_segs=rel_path_segs,
            upper_method=upper_method,
            rule_entries=rule_entries,
        )

    selected_name = _selected_owner_name(
        collection,
        intent,
        upper_method=upper_method,
        path=decision_path,
    )
    if isinstance(selected_name, FirewallAmbiguous):
        return selected_name
    result = _reduce_selected_owner(
        collection,
        selected_name=selected_name,
        compiled_network_policies=compiled_network_policies,
        upper_method=upper_method,
        indexed_rules=indexed_rules,
    )
    if is_asterisk_form and isinstance(result, FirewallAllow):
        return FirewallPolicyAllow(result)
    return result


def _prepare_compiled_request_match(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None,
) -> tuple[_BaseUrlParts, bool, str, CompiledNetworkPolicies] | None:
    if not compiled_firewalls:
        return None

    url_has_backslash = "\\" in url
    url_parts = _split_base_match_url(
        url,
        allow_runtime_backslash_syntax=url_has_backslash,
    )
    if url_parts is None:
        return None

    return (
        url_parts,
        url_has_backslash,
        method.upper(),
        _ensure_compiled_network_policies(network_policies),
    )


def _match_compiled_firewall_request_linear(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None = None,
    intent: connector_intent.ConnectorIntent | None = None,
    *,
    is_asterisk_form: bool = False,
) -> FirewallAllow | FirewallPolicyAllow | FirewallBlock | FirewallAmbiguous | None:
    prepared = _prepare_compiled_request_match(
        url,
        method,
        compiled_firewalls,
        network_policies,
    )
    if prepared is None or compiled_firewalls is None:
        return None

    url_parts, url_has_backslash, upper_method, compiled_network_policies = prepared
    return _match_compiled_firewall_request_with_api_candidates(
        url_parts=url_parts,
        url_has_backslash=url_has_backslash,
        upper_method=upper_method,
        compiled_network_policies=compiled_network_policies,
        api_candidates=compiled_firewalls.linear_api_candidates(),
        indexed_rules=False,
        intent=intent or connector_intent.ABSENT,
        is_asterisk_form=is_asterisk_form,
    )


def match_compiled_firewall_request(
    url: str,
    method: str,
    compiled_firewalls: CompiledFirewallSet | None,
    network_policies: object | None = None,
    intent: connector_intent.ConnectorIntent | None = None,
    *,
    is_asterisk_form: bool = False,
) -> FirewallAllow | FirewallPolicyAllow | FirewallBlock | FirewallAmbiguous | None:
    """Match request against production precompiled firewall permissions.

    Retained malformed state from the compile functions applies only after the
    request matches a compiled base. It can surface as FirewallBlock reasons
    ``malformed_firewall_config`` or ``malformed_network_policy``; unsafe paths
    use ``unsafe_path`` after base match. APIs with malformed firewall name,
    base, or auth config do not evaluate their rules; malformed permission/rule
    config can still leave valid compiled rules eligible. Malformed top-level
    policies or malformed allow/deny/ask permission sets skip rule evaluation
    for the matched API. Recorded allow/deny rule decisions keep their current
    precedence over retained malformed state, and malformed ``unknownPolicy``
    only affects unknown-endpoint resolution.

    Returns:
      FirewallAllow — granted permission matched or unknown endpoint allowed
      FirewallPolicyAllow — asterisk-form unknown endpoint allowed without auth
      FirewallBlock — permission denied, unknown endpoint blocked, or matched
        malformed firewall/network policy config or unsafe path failed closed
      FirewallAmbiguous — multiple connector owners require a usable intent
      None — no base URL match (not a firewall request)

    ``unknownPolicy="ask"`` is treated as block at the proxy layer.

    When ``is_asterisk_form`` is true, the URL contains the reconstructed
    authority with an empty path. The matcher selects the applicable base and
    owner but skips endpoint permissions, then reports ``*`` as the decision
    path while resolving the request through unknown-policy semantics.
    """
    prepared = _prepare_compiled_request_match(
        url,
        method,
        compiled_firewalls,
        network_policies,
    )
    if prepared is None or compiled_firewalls is None:
        return None

    url_parts, url_has_backslash, upper_method, compiled_network_policies = prepared
    return _match_compiled_firewall_request_with_api_candidates(
        url_parts=url_parts,
        url_has_backslash=url_has_backslash,
        upper_method=upper_method,
        compiled_network_policies=compiled_network_policies,
        api_candidates=compiled_firewalls.indexed_api_candidates(url_parts),
        indexed_rules=True,
        intent=intent or connector_intent.ABSENT,
        is_asterisk_form=is_asterisk_form,
    )
