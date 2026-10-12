#!/usr/bin/env python3
"""Read bot discovery metadata without exposing credentials or starting a session."""

import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def describe(value):
    """Only numeric metadata is printable; provider strings and objects are not."""
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            return {"type": "non-finite-number"}
        return {"type": "number", "value": value, "integer": value == int(value)}
    if isinstance(value, str):
        return {"type": "string"}
    if isinstance(value, list):
        return {"type": "array"}
    return {"type": "object"}


def field(value, name):
    if not isinstance(value, dict) or name not in value:
        return {"type": "missing"}
    return describe(value[name])


def emit(**values):
    print(json.dumps(values, allow_nan=False), flush=True)


def main():
    token = os.environ.get("DISCORD_BOT_TOKEN", "")
    application_id = os.environ.get("DISCORD_APPLICATION_ID", "")
    if not token or re.search(r"\s", token) or not re.fullmatch(r"\d{17,20}", application_id):
        emit(error="invalid-configuration")
        return 1

    opener = urllib.request.build_opener(NoRedirect())
    stage = "application"
    try:
        for stage, path in (("application", "/applications/@me"), ("gateway", "/gateway/bot")):
            request = urllib.request.Request(
                "https://discord.com/api/v10" + path,
                headers={"Authorization": "Bot " + token, "User-Agent": "OkouGatewayDiagnostics/1.0"},
                method="GET",
            )
            with opener.open(request, timeout=10) as response:
                emit(stage=stage, httpStatus=response.status)
                body = response.read(65537)
            if len(body) > 65536:
                emit(stage=stage, error="response-too-large")
                return 1
            data = json.loads(body)
            if not isinstance(data, dict):
                emit(stage=stage, error="unexpected-response-shape")
                return 1
            if stage == "application":
                matches = data.get("id") == application_id
                emit(stage=stage, applicationIdMatches=matches)
                if not matches:
                    return 1
                continue

            fields = {"url": field(data, "url"), "shards": field(data, "shards")}
            if isinstance(data.get("url"), str):
                try:
                    url = urllib.parse.urlsplit(data["url"])
                    fields["url"].update(
                        schemeIsWss=url.scheme == "wss",
                        hostnameIsDiscord=url.hostname == "gateway.discord.gg"
                        or bool(url.hostname and url.hostname.endswith(".discord.gg")),
                        hasCredentials=bool(url.username or url.password),
                        hasPort=url.port is not None,
                    )
                except ValueError:
                    fields["url"]["parseable"] = False
            fields["session_start_limit"] = field(data, "session_start_limit")
            for name in ("total", "remaining", "reset_after", "max_concurrency"):
                fields["session_start_limit." + name] = field(data.get("session_start_limit"), name)
            emit(stage=stage, fields=fields)
            return 0
    except urllib.error.HTTPError as error:
        emit(stage=stage, error="http-error", httpStatus=error.code)
        error.close()
    except (urllib.error.URLError, TimeoutError, OSError):
        emit(stage=stage, error="transport-error")
    except (ValueError, OverflowError):
        emit(stage=stage, error="invalid-response")
    return 1


if __name__ == "__main__":
    sys.exit(main())
