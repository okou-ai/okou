"""Shared HTTP-layer drivers for real mitmproxy framing tests."""

from h2.config import H2Configuration
from h2.connection import H2Connection
from mitmproxy import connection
from mitmproxy.proxy import commands, events
from mitmproxy.proxy.context import Context
from mitmproxy.proxy.layers.http import HttpLayer, HTTPMode
from mitmproxy.proxy.layers.http._hooks import HttpRequestHeadersHook
from mitmproxy.test import taddons

CLIENT_IP = "10.200.0.5"
PLACEHOLDER_HOST = "placeholder.example.com"


def start_http_layer(
    addon_context: taddons.context,
    *,
    alpn: bytes,
    host: str = PLACEHOLDER_HOST,
    server_host: str | None = None,
    server_port: int = 443,
    mode: HTTPMode = HTTPMode.regular,
    commands_out: list[commands.Command] | None = None,
) -> tuple[connection.Client, HttpLayer]:
    client = connection.Client(
        peername=(CLIENT_IP, 12345),
        sockname=("127.0.0.1", 8080),
        state=connection.ConnectionState.OPEN,
        tls=True,
        alpn=alpn,
        sni=host,
    )
    context = Context(client, addon_context.options)
    context.server.address = (server_host or host, server_port)
    if mode is HTTPMode.transparent:
        context.server.tls = True
    http_layer = HttpLayer(context, mode)
    initial = list(http_layer.handle_event(events.Start()))
    if commands_out is not None:
        commands_out.extend(initial)
    return client, http_layer


def start_http2_request(
    addon_context: taddons.context,
    *,
    method: str,
    end_stream: bool,
    regular_headers: tuple[tuple[bytes, bytes], ...] = (),
    host: str = PLACEHOLDER_HOST,
    path: str = "/",
) -> tuple[HttpLayer, HttpRequestHeadersHook]:
    client, http_layer = start_http_layer(addon_context, alpn=b"h2", host=host)

    http2 = H2Connection(H2Configuration(client_side=True, header_encoding=None))
    http2.initiate_connection()
    http2.send_headers(
        1,
        [
            (b":method", method.encode()),
            (b":scheme", b"https"),
            (b":authority", host.encode()),
            (b":path", path.encode()),
            *regular_headers,
        ],
        end_stream=end_stream,
    )
    commands = list(http_layer.handle_event(events.DataReceived(client, http2.data_to_send())))
    request_headers_hook = next(
        command for command in commands if isinstance(command, HttpRequestHeadersHook)
    )
    return http_layer, request_headers_hook
