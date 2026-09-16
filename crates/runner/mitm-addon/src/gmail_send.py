"""Fixed Gmail send restriction for the non-browser request path."""

from urllib.parse import unquote

from path_security import has_unsafe_path

_GMAIL_HOST = "gmail.googleapis.com"
_GOOGLE_API_HOSTS = frozenset((_GMAIL_HOST, "www.googleapis.com"))
_GMAIL_PREFIXES = ("/gmail/", "/upload/gmail/", "/resumable/upload/gmail/", "/batch/gmail/")
_MAX_DECODE_PASSES = 5


def blocks_gmail_send(host: str, request_path: str) -> bool:
    """Match trusted hosts and bounded paths without inspecting or forwarding a body.

    Query values never select the operation. Decode equivalent endpoint spellings
    locally; do not change the request or the generic firewall matcher's grammar.
    Gmail-specific batch calls are blocked as a whole because they can contain sends.
    """
    if host not in _GOOGLE_API_HOSTS:
        return False

    path = request_path.partition("?")[0]
    if has_unsafe_path(path):
        # Preserve fail-closed handling for malformed Gmail API paths without
        # imposing Gmail policy on unrelated shared-host Google APIs.
        return host == _GMAIL_HOST or path.startswith(_GMAIL_PREFIXES)

    for _ in range(_MAX_DECODE_PASSES):
        decoded = unquote(path, errors="strict")
        if decoded == path:
            break
        path = decoded

    segments = [segment for segment in path.split("/") if segment]
    if host == _GMAIL_HOST and segments[:1] == ["batch"]:
        return True
    if segments[:3] == ["batch", "gmail", "v1"]:
        return True
    if segments[:2] == ["resumable", "upload"]:
        segments = segments[2:]
    elif segments[:1] == ["upload"]:
        segments = segments[1:]
    match segments:
        case ["gmail", "v1", "users", _, "messages" | "drafts", "send"]:
            return True
        case _:
            return False
