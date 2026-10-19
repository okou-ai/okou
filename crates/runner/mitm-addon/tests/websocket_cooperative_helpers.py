"""Protocol-shaped expensive messages and awaited production-hook delivery."""

import json

import mitm_addon
from tests.model_provider_websocket_helpers import append_websocket_message


def costly_message(side, repetitions):
    text = "中" * repetitions
    if side == "client":
        event = {
            "type": "response.create",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": text}]}],
        }
    else:
        response: dict = {"id": "resp_costly", "model": "gpt-5.5"}
        if side == "terminal":
            response["output"] = [{"content": [{"type": "output_text", "text": text}]}]
            response["usage"] = {"input_tokens": 9, "output_tokens": 4}
        else:
            response["instructions"] = text
        event = {
            "type": "response.completed" if side == "terminal" else "response.created",
            "response": response,
        }
    return json.dumps(event).encode()


async def deliver(flow, body, *, from_client=False):
    message = append_websocket_message(flow, from_client=from_client, content=body)
    completion = mitm_addon.websocket_message(flow)
    if completion is not None:
        await completion
    assert message.content == body
    assert not message.dropped
    return message
