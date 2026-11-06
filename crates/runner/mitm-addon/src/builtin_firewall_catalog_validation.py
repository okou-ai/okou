"""Decoded builtin catalog acceptance, separate from file and cache ownership.

The cache owns bounded reads, JSON decoding, descriptor identity and publication.
This module validates decoded values before they can be bound to file provenance.
Catalog witnesses remain distinct from shared layout and runtime value policy.
"""

import codecs
import re
from dataclasses import dataclass, field
from urllib.parse import unquote_to_bytes

import builtin_base_url_template
import builtin_host_policy
import matching
from authority_utils import percent_decode_host
from generated.builtin_firewall_cache import BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION
from path_security import has_unsafe_url_path
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

_SHA256_HEX_LENGTH = 64
# Keep component witnesses small; hostname fragments also preserve adjacent
# literal label boundaries when materialized below.
_BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER = "https://x.y"
_BASE_URL_TEMPLATE_HOST_PLACEHOLDER = "x.y"
_BASE_URL_TEMPLATE_PORT_PLACEHOLDER = "1"
_BASE_URL_TEMPLATE_PATH_PLACEHOLDER = "x"
_BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS = re.compile(r"([.:/?#@\[\]\u3002\uff0e\uff61])")
_BASE_URL_TEMPLATE_OPEN_HOST_ESCAPE = re.compile(r"%[0-9a-fA-F]?$")
_BASE_URL_TEMPLATE_PERCENT_ESCAPE_LENGTH = 3
_BASE_URL_TEMPLATE_ENCODED_HOST_STRUCTURE = frozenset(r".:/?#@[]\%{}*")
_BASE_URL_TEMPLATE_PLACEHOLDERS: dict[
    builtin_base_url_template.BaseUrlTemplateComponentKind, str
] = {
    "whole-base": _BASE_URL_TEMPLATE_WHOLE_BASE_PLACEHOLDER,
    "whole-authority": _BASE_URL_TEMPLATE_HOST_PLACEHOLDER,
    "authority-fragment": _BASE_URL_TEMPLATE_HOST_PLACEHOLDER,
    "port": _BASE_URL_TEMPLATE_PORT_PLACEHOLDER,
    "path": _BASE_URL_TEMPLATE_PATH_PLACEHOLDER,
}


class BuiltinFirewallCatalogCacheError(ValueError):
    """Builtin firewall catalog cache is unavailable or malformed."""


@dataclass(frozen=True)
class ValidatedCatalog:
    """Completed catalog validation, without file identity or cache state."""

    catalog_digest: str
    catalog_version: str
    firewalls: dict[str, dict] = field(repr=False)


def validate_catalog(raw: object) -> ValidatedCatalog:
    """Validate one decoded catalog without acquiring file or cache ownership."""
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

    return ValidatedCatalog(
        catalog_digest=catalog_digest,
        catalog_version=catalog_version,
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
    validated_rules: set[str] = set()
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
            _validate_api_entry(name, api, validated_rules)


def _validate_api_entry(firewall_name: str, api: dict, validated_rules: set[str]) -> None:
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
            if rule not in validated_rules:
                if not matching.firewall_rule_is_valid(rule):
                    raise BuiltinFirewallCatalogCacheError(
                        f'catalog cache firewall "{firewall_name}" permission rule is invalid'
                    )
                validated_rules.add(rule)


def _base_url_template_syntax_target(firewall_name: str, raw_base: str) -> str | None:
    try:
        variables = builtin_base_url_template.analyze_base_url_template(raw_base)
    except builtin_base_url_template.BaseUrlTemplateLayoutError as e:
        raise BuiltinFirewallCatalogCacheError(
            f'catalog cache firewall "{firewall_name}" api {e}'
        ) from e
    if not variables:
        return None

    literal_parts: list[str] = []
    last_index = 0
    for variable in variables:
        literal_parts.append(raw_base[last_index : variable.reference.start])
        last_index = variable.reference.end
    literal_parts.append(raw_base[last_index:])

    for index, variable in enumerate(variables):
        if variable.authority_fragment_shape == "hostname":
            literal_parts[index] = _base_url_template_hostname_literal_syntax_target(
                literal_parts[index], trailing=True
            )
            literal_parts[index + 1] = _base_url_template_hostname_literal_syntax_target(
                literal_parts[index + 1], trailing=False
            )

    result: list[str] = []
    for index, variable in enumerate(variables):
        result.append(literal_parts[index])
        placeholder = _BASE_URL_TEMPLATE_PLACEHOLDERS[variable.kind]
        if variable.authority_fragment_shape == "ip-literal":
            placeholder = _BASE_URL_TEMPLATE_PORT_PLACEHOLDER
        elif variable.authority_fragment_shape == "hostname":
            placeholder = _base_url_template_hostname_placeholder(
                literal_parts[index], literal_parts[index + 1]
            )
        result.append(placeholder)
    result.append(literal_parts[-1])
    return "".join(result)


def _base_url_template_hostname_literal_syntax_target(literal: str, *, trailing: bool) -> str:
    if trailing and (escape := _BASE_URL_TEMPLATE_OPEN_HOST_ESCAPE.search(literal)) is not None:
        prefix = literal[: escape.start()]
        try:
            prefix_bytes = unquote_to_bytes(prefix)
            _, consumed = codecs.utf_8_decode(prefix_bytes, "strict", False)
        except UnicodeError:
            return literal
        # A variable can finish a UTF-8 character as well as its final octet.
        # Retain every complete character, including encoded URL structure, and
        # project only the unfinished character. Final resolution checks it all.
        pending = len(prefix_bytes) - consumed
        literal = prefix[: len(prefix) - pending * _BASE_URL_TEMPLATE_PERCENT_ESCAPE_LENGTH] + "x"
    parts = _BASE_URL_TEMPLATE_HOST_LABEL_DELIMITERS.split(literal)
    index = -1 if trailing else 0
    decoded = percent_decode_host(
        parts[index], syntax_chars=_BASE_URL_TEMPLATE_ENCODED_HOST_STRUCTURE
    )
    if (
        decoded.invalid_encoding
        or decoded.decoded_syntax
        or not decoded.value.isascii()
        or not decoded.value.lower().startswith("xn--")
    ):
        return literal

    syntax_label = "idna" + decoded.value[len("xn--") :]
    if not _base_url_template_literal_label_is_valid(syntax_label):
        return literal

    # An adjoining variable can complete or extend the A-label payload. Project
    # its prefix to ordinary ASCII of the same decoded length for syntax/length
    # checks, without guessing a valid punycode expansion. Reuse the existing
    # label grammar; malformed encoding and introduced URL syntax stay intact.
    # The actual resolved base still undergoes full IDNA and host-policy checks.
    parts[index] = syntax_label
    return "".join(parts)


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
