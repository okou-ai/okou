"""Pure firewall auth config predicates."""

from typing import NamedTuple
from urllib.parse import urlsplit

import connector_template_syntax
from firewall_matching.base_url import _split_base_match_url
from path_security import has_unsafe_path
from url_syntax import has_raw_whitespace, has_unsafe_url_codepoint

_VALID_AUTH_BASE_SCHEME = "https"
_AUTH_TEMPLATE_START = "${{"
_AUTH_TEMPLATE_URL_PLACEHOLDER = "placeholder"


def _non_empty_mapping(value: object) -> bool:
    return isinstance(value, dict) and bool(value)


def auth_config_injects_ordinary_upstream_credentials(auth_config: object) -> bool:
    """Return whether auth mutates the ordinary mitmproxy upstream request."""
    if not isinstance(auth_config, dict):
        return False
    if _non_empty_mapping(auth_config.get("headers")):
        return True
    if _non_empty_mapping(auth_config.get("query")):
        return True
    return _non_empty_mapping(auth_config.get("awsSigv4"))


def auth_config_injects_credentials(auth_config: object) -> bool:
    """Return whether a firewall auth config can add managed credentials."""
    if not isinstance(auth_config, dict):
        return False
    if auth_config_injects_ordinary_upstream_credentials(auth_config):
        return True
    return isinstance(auth_config.get("base"), str) and auth_config["base"] != ""


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


def firewall_api_auth_config_is_valid(api_entry: dict) -> bool:
    """Return whether an API entry auth config has a valid runtime shape."""
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
