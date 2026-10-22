"""Classify public destination addresses for credential-bearing firewall traffic.

"Public" is this repository's explicit native public-unicast policy, not a
guarantee that an address is reachable from a particular network. IPv4 follows
the globally reachable distinctions in the IANA IPv4 Special-Purpose Address
Registry, together with the non-unicast address space. IPv6 is deliberately
limited to native global unicast in ``2000::/3`` and excludes mapped, scoped,
Teredo, 6to4, documentation, and other special-purpose forms. The normally
non-global ``2001::/23`` block admits only its more-specific globally reachable
allocations.

The explicit tables are intentional. Supported Python ``ipaddress`` versions
can lag registry updates, and ``is_global`` also admits transition forms outside
this policy. Authoritative sources:

- https://www.iana.org/assignments/iana-ipv4-special-registry/
- https://www.iana.org/assignments/iana-ipv6-special-registry/
- https://www.iana.org/assignments/ipv6-unicast-address-assignments/
- https://www.rfc-editor.org/rfc/rfc4291.html

``builtin_host_policy.py`` rejects unsafe configured or observed literals.
``request_classification.py`` validates concrete request destinations before
credentials are used; it may defer an ordinary hostname during header
processing, but request processing must later validate concrete endpoint
evidence. ``auth_base_transport.py`` validates every resolved address before
connecting. A hostname classification is therefore a deferral, never proof
that its eventual address is public.

The range policy is owned by ``public-destination-policy.ts`` for connector
base validation and generated into ``generated/public_destination_policy.py``
for this runtime. Both runtimes validate canonical membership through the same
shared boundary contract.
"""

import ipaddress
from dataclasses import dataclass
from typing import Literal

from generated.public_destination_policy import (
    IPV4_NON_PUBLIC_RANGES,
    IPV6_AMT_SECOND,
    IPV6_AS112_SECOND,
    IPV6_AS112_THIRD,
    IPV6_DOCUMENTATION_SECOND,
    IPV6_DRONE_REMOTE_ID_SECOND_MAX,
    IPV6_DRONE_REMOTE_ID_SECOND_MIN,
    IPV6_EXPANDED_DOCUMENTATION_FIRST,
    IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX,
    IPV6_GLOBAL_UNICAST_FIRST_MAX,
    IPV6_GLOBAL_UNICAST_FIRST_MIN,
    IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST,
    IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX,
    IPV6_ORCHID_SECOND_MAX,
    IPV6_ORCHID_SECOND_MIN,
    IPV6_SIX_TO_FOUR_FIRST,
    IPV6_SPECIAL_EXACT_LAST_MAX,
    IPV6_SPECIAL_EXACT_LAST_MIN,
    IPV6_SPECIAL_EXACT_SECOND,
)
from host_normalization import (
    normalize_hostname,
    normalize_idna_hostname,
    translate_idna_dot_separators,
)

_IPV4_HEX_PREFIX = "0x"
_IPV4_LITERAL_MAX_COMPONENTS = 4

# Reasons produced when a concrete runtime destination cannot be approved:
# `missing_destination` means no usable destination evidence was supplied;
# `invalid_destination` means the evidence is not accepted concrete IP-literal
# syntax; `non_public_destination` means a valid address was rejected by policy.
DestinationDenialReason = Literal[
    "missing_destination",
    "invalid_destination",
    "non_public_destination",
]
_RuntimeDestinationHostKind = Literal[
    "missing",
    "invalid",
    "non_public",
    "public",
    "hostname",
    "deferable_hostname",
]
_HostnameClassificationMode = Literal["skip", "generic", "deferable"]


@dataclass(frozen=True)
class RuntimeDestinationCheck:
    """Result produced by ``validate_runtime_destination_host()``.

    Validator-produced results have ``allowed=True`` exactly when ``reason`` is
    ``None``; denied results carry a ``DestinationDenialReason``. The dataclass
    constructor itself does not enforce that correlation.

    ``destination_host`` is diagnostic context, not a trusted or canonical
    authority. It preserves a supplied non-empty string, while non-string or
    whitespace-only missing input is represented as an empty string.
    """

    allowed: bool
    destination_host: str
    reason: DestinationDenialReason | None = None


@dataclass(frozen=True)
class RuntimeDestinationHostClassification:
    """One interpretation of host text within a runtime-destination pass.

    ``validation`` preserves the concrete-IP contract exposed by
    ``validate_runtime_destination_host()``. ``is_hostname`` distinguishes an
    ordinary IDNA hostname from malformed text so connected endpoint collection
    can ignore unresolved names. ``deferable_hostname`` additionally requires
    trusted-authority syntax and is true only when ``is_hostname`` is true.
    """

    validation: RuntimeDestinationCheck
    is_hostname: bool = False
    deferable_hostname: bool = False


def classify_runtime_destination_host(
    destination_host: object,
) -> RuntimeDestinationHostClassification:
    """Classify runtime host text once for collection, deferral, and validation."""

    kind = _runtime_destination_host_kind(
        destination_host,
        hostname_classification="deferable",
    )
    return RuntimeDestinationHostClassification(
        validation=_runtime_destination_check(destination_host, kind),
        is_hostname=kind in ("hostname", "deferable_hostname"),
        deferable_hostname=kind == "deferable_hostname",
    )


def _runtime_destination_host_kind(
    destination_host: object,
    *,
    hostname_classification: _HostnameClassificationMode,
) -> _RuntimeDestinationHostKind:
    """Parse only the hostname detail required by the calling contract.

    ``skip`` treats non-IP text as invalid concrete evidence. ``generic``
    distinguishes ordinary IDNA hostnames for the tri-state literal adapter.
    ``deferable`` additionally records trusted-authority eligibility.
    """

    if not isinstance(destination_host, str):
        return "missing"

    ip_text = destination_host.strip()
    if not ip_text:
        return "missing"
    if ip_text != destination_host:
        return "invalid"

    bracketed = ip_text.startswith("[") or ip_text.endswith("]")
    if bracketed:
        if not (ip_text.startswith("[") and ip_text.endswith("]")):
            return "invalid"
        ip_text = ip_text[1:-1]
        if not ip_text:
            return "invalid"

    try:
        ip = ipaddress.ip_address(ip_text)
    except ValueError:
        if bracketed or _looks_like_legacy_ipv4_literal(ip_text):
            return "invalid"
        if hostname_classification == "skip":
            return "invalid"
        if hostname_classification == "deferable":
            try:
                normalize_hostname(ip_text)
            except UnicodeError, ValueError:
                pass
            else:
                return "deferable_hostname"
        try:
            normalize_idna_hostname(ip_text)
        except UnicodeError, ValueError:
            return "invalid"
        return "hostname"

    if bracketed and not isinstance(ip, ipaddress.IPv6Address):
        return "invalid"

    if not _ip_address_is_public(ip):
        return "non_public"

    return "public"


def _runtime_destination_check(
    destination_host: object,
    kind: _RuntimeDestinationHostKind,
) -> RuntimeDestinationCheck:
    diagnostic_host = (
        destination_host if isinstance(destination_host, str) and kind != "missing" else ""
    )
    if kind == "public":
        return RuntimeDestinationCheck(
            allowed=True,
            destination_host=diagnostic_host,
        )
    if kind == "missing":
        reason: DestinationDenialReason = "missing_destination"
    elif kind == "non_public":
        reason = "non_public_destination"
    else:
        reason = "invalid_destination"
    return RuntimeDestinationCheck(
        allowed=False,
        destination_host=diagnostic_host,
        reason=reason,
    )


def public_ip_literal_is_public(hostname: str) -> bool | None:
    """Classify exact host text as a public literal, rejected input, or hostname.

    Return ``True`` for an accepted public IPv4 or IPv6 literal. IPv6 may be
    unbracketed or enclosed by one matching bracket pair; bracketed IPv4 is
    rejected.

    Return ``False`` for non-public literals and for text that must not be
    deferred as a hostname, including empty or whitespace-altered input,
    malformed brackets, scoped input, legacy numeric IPv4 forms, and invalid
    IDNA host syntax.

    Return ``None`` only for an ordinary valid hostname. This means that no
    concrete address was classified; callers must validate the eventual
    endpoint rather than treating ``None`` as approval.
    """

    kind = _runtime_destination_host_kind(
        hostname,
        hostname_classification="generic",
    )
    if kind in ("hostname", "deferable_hostname"):
        return None
    return kind == "public"


def validate_runtime_destination_host(destination_host: object) -> RuntimeDestinationCheck:
    """Require concrete runtime destination evidence to be a public IP literal.

    Non-string, empty, and whitespace-only values produce
    ``missing_destination``. Surrounding whitespace, ordinary hostnames,
    malformed literals, and invalid bracket forms produce
    ``invalid_destination``. Valid but disallowed addresses produce
    ``non_public_destination``. Only a valid public IPv4 literal or an
    unbracketed/bracketed public IPv6 literal produces an allowed result.

    The ``object`` input is intentional: absent or malformed endpoint evidence
    is denied instead of requiring callers to narrow it first. See
    ``RuntimeDestinationCheck`` for the diagnostic host-field contract.
    """

    kind = _runtime_destination_host_kind(
        destination_host,
        hostname_classification="skip",
    )
    return _runtime_destination_check(destination_host, kind)


def ip_address_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Apply the shared public-unicast policy to an already-parsed address.

    This function performs no hostname classification, text normalization, or
    DNS resolution.
    """

    return _ip_address_is_public(ip)


def _ip_address_is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address):
        if (
            ip.scope_id is not None
            or ip.ipv4_mapped is not None
            or ip.sixtofour is not None
            or ip.teredo is not None
        ):
            return False
        return _ipv6_literal_is_public_unicast(ip)
    return _ipv4_literal_is_public(ip)


def _ipv4_literal_is_public(ip: ipaddress.IPv4Address) -> bool:
    value = int(ip)
    return not any(start <= value <= end for start, end in IPV4_NON_PUBLIC_RANGES)


def _looks_like_ipv4_number_component(value: str) -> bool:
    if not value:
        return False
    if value.lower().startswith(_IPV4_HEX_PREFIX):
        return len(value) > len(_IPV4_HEX_PREFIX) and all(
            char in "0123456789abcdefABCDEF" for char in value[len(_IPV4_HEX_PREFIX) :]
        )
    return value.isdecimal()


def _looks_like_legacy_ipv4_literal(hostname: str) -> bool:
    normalized = translate_idna_dot_separators(hostname)
    if normalized.endswith("."):
        normalized = normalized[:-1]
    parts = normalized.split(".")
    return 1 <= len(parts) <= _IPV4_LITERAL_MAX_COMPONENTS and all(
        _looks_like_ipv4_number_component(part) for part in parts
    )


def _ipv6_word(ip: ipaddress.IPv6Address, index: int) -> int:
    return (int(ip) >> (112 - (index * 16))) & 0xFFFF


def _ipv6_special_registry_exception(ip: ipaddress.IPv6Address) -> bool:
    second = _ipv6_word(ip, 1)
    if (
        second == IPV6_SPECIAL_EXACT_SECOND
        and _ipv6_word(ip, 2) == 0
        and _ipv6_word(ip, 3) == 0
        and _ipv6_word(ip, 4) == 0
        and _ipv6_word(ip, 5) == 0
        and _ipv6_word(ip, 6) == 0
        and IPV6_SPECIAL_EXACT_LAST_MIN <= _ipv6_word(ip, 7) <= IPV6_SPECIAL_EXACT_LAST_MAX
    ):
        return True
    if second == IPV6_AMT_SECOND:
        return True
    if second == IPV6_AS112_SECOND and _ipv6_word(ip, 2) == IPV6_AS112_THIRD:
        return True
    if IPV6_ORCHID_SECOND_MIN <= second <= IPV6_ORCHID_SECOND_MAX:
        return True
    return IPV6_DRONE_REMOTE_ID_SECOND_MIN <= second <= IPV6_DRONE_REMOTE_ID_SECOND_MAX


def _ipv6_literal_is_public_unicast(ip: ipaddress.IPv6Address) -> bool:
    first = _ipv6_word(ip, 0)
    second = _ipv6_word(ip, 1)
    if first < IPV6_GLOBAL_UNICAST_FIRST_MIN or first > IPV6_GLOBAL_UNICAST_FIRST_MAX:
        return False
    if (
        first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST
        and second <= IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX
    ):
        return _ipv6_special_registry_exception(ip)
    if first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST and second == IPV6_DOCUMENTATION_SECOND:
        return False
    if (
        first == IPV6_EXPANDED_DOCUMENTATION_FIRST
        and second <= IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX
    ):
        return False
    return first != IPV6_SIX_TO_FOUR_FIRST
