"""Fixed Gmail send restriction for the non-browser request path."""

from posixpath import normpath
from urllib.parse import unquote

from path_security import MAX_PATH_VALIDATION_CHARACTERS, has_unsafe_path

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
        if host == _GMAIL_HOST or path.startswith(_GMAIL_PREFIXES):
            return True
        if len(path) > MAX_PATH_VALIDATION_CHARACTERS:
            return False
        # A shared-host path can still resolve to Gmail after decoding and dot
        # removal. Do not rely on a matching configurable firewall to reject it.

    for _ in range(_MAX_DECODE_PASSES):
        try:
            decoded = unquote(path, errors="strict")
        except UnicodeDecodeError:
            # Invalid UTF-8 cannot identify a Gmail endpoint. Retain ordinary
            # shared-host path policy instead of failing the request hook.
            return False
        if decoded == path:
            break
        path = decoded

    segments = [segment for segment in normpath(path).split("/") if segment]
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
