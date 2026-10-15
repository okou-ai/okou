"""URL operations for request-lifetime inputs."""

import urllib.parse

_uncached_urlsplit = urllib.parse.urlsplit.__wrapped__


def strip_url_query_and_fragment(value: str) -> str:
    """Return the URL prefix before its raw query or fragment delimiter."""
    query_start = value.find("?")
    fragment_start = value.find("#", 0, query_start if query_start >= 0 else len(value))
    if fragment_start >= 0:
        return value[:fragment_start]
    if query_start >= 0:
        return value[:query_start]
    return value


def split_runtime_url(value: str) -> urllib.parse.SplitResult:
    """Split a runtime URL without retaining it in urllib's process-wide LRU."""
    return _uncached_urlsplit(value)


def runtime_url_path(value: str) -> str:
    """Return urlparse-style path semantics without caching or copying a query."""
    parsed = split_runtime_url(strip_url_query_and_fragment(value))
    path = parsed.path
    if parsed.scheme in urllib.parse.uses_params:
        # urlparse separates parameters only from the final path segment.
        params_start = path.find(";", path.rfind("/") + 1)
        if params_start >= 0:
            return path[:params_start]
    return path
