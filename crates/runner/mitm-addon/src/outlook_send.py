"""Require human confirmation for Microsoft Graph mail sends."""

from posixpath import normpath
from urllib.parse import unquote

from path_security import has_unsafe_path

_USER_RESOURCE_SEGMENTS = 2
_SEND_ACTIONS = frozenset(("send", "reply", "replyall", "forward"))


def blocks_outlook_send(
    host: str,
    request_path: str,
    connector_owner: str | None,
    *,
    defer_batch: bool = False,
) -> bool:
    if host != "graph.microsoft.com":
        return False
    path = request_path.partition("?")[0]
    if has_unsafe_path(path):
        return True
    for _ in range(5):
        try:
            decoded = unquote(path, errors="strict")
        except UnicodeDecodeError:
            return True
        if decoded == path:
            break
        path = decoded
    segments = [segment.lower() for segment in normpath(path).split("/") if segment]
    if segments[:1] not in (["v1.0"], ["beta"]):
        return False
    resource = segments[1:]
    if resource == ["$batch"]:
        # These independently routed built-ins do not grant Mail.Send. Preserve
        # their non-mail batching; mail-capable/ambiguous batches use direct reads
        # and draft edits so an embedded send cannot bypass confirmation.
        return not defer_batch and connector_owner not in ("microsoft-365", "outlook-calendar")
    if resource[:1] == ["me"]:
        resource = resource[1:]
    elif resource[:1] == ["users"] and len(resource) >= _USER_RESOURCE_SEGMENTS:
        resource = resource[2:]
    elif resource and resource[0].startswith("users("):
        resource = resource[1:]
    else:
        return False
    if not resource:
        return False
    if resource[:1] == ["microsoft.graph.user"]:
        resource = resource[1:]
    if not resource:
        return False
    if len(resource) == 1:
        return resource[0].rsplit(".", 1)[-1] == "sendmail"
    if resource[0].split("(", 1)[0] not in ("messages", "mailfolders"):
        return False
    match resource:
        case [*_, "messages", _, action] | [*_, "messages", _, "microsoft.graph.message", action]:
            return action.rsplit(".", 1)[-1] in _SEND_ACTIONS
        case [*_, bound, "microsoft.graph.message", action] | [*_, bound, action]:
            return bound.startswith("messages(") and action.rsplit(".", 1)[-1] in _SEND_ACTIONS
        case _:
            return False
