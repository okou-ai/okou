"""Canonical OpenAI Responses protocol event vocabulary."""

CLIENT_CREATE_EVENT = "response.create"
SERVER_CREATED_EVENT = "response.created"
SERVER_ERROR_EVENT = "error"

# Terminal Responses events whose Response object may carry usage. WebSocket
# source eviction relies on these events being final for the logical response id;
# protocols with mutable post-terminal usage snapshots need a source-upsert
# contract instead of source-preserving append-only events. ``response.done`` is
# retained as the established compatibility terminal.
TERMINAL_EVENTS = frozenset(
    ("response.completed", "response.done", "response.incomplete", "response.failed")
)

SERVER_LIFECYCLE_EVENTS = TERMINAL_EVENTS | {
    SERVER_CREATED_EVENT,
    SERVER_ERROR_EVENT,
}

# Keep exact current official Responses stream event literals plus established
# compatibility literals. Unknown names intentionally retain full extraction so
# schema drift cannot silently skip a future usage-bearing event.
KNOWN_NON_USAGE_EVENTS = frozenset(
    (
        SERVER_ERROR_EVENT,
        "response.audio.delta",
        "response.audio.done",
        "response.audio.transcript.delta",
        "response.audio.transcript.done",
        "response.code_interpreter_call.code.delta",
        "response.code_interpreter_call.completed",
        "response.code_interpreter_call.in_progress",
        "response.code_interpreter_call.interpreting",
        "response.code_interpreter_call_code.delta",
        "response.code_interpreter_call_code.done",
        "response.content_part.added",
        "response.content_part.done",
        SERVER_CREATED_EVENT,
        "response.custom_tool_call_input.delta",
        "response.custom_tool_call_input.done",
        "response.file_search_call.completed",
        "response.file_search_call.in_progress",
        "response.file_search_call.searching",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.image_generation_call.completed",
        "response.image_generation_call.generating",
        "response.image_generation_call.in_progress",
        "response.image_generation_call.partial_image",
        "response.in_progress",
        "response.mcp_call.completed",
        "response.mcp_call.failed",
        "response.mcp_call.in_progress",
        "response.mcp_call_arguments.delta",
        "response.mcp_call_arguments.done",
        "response.mcp_list_tools.completed",
        "response.mcp_list_tools.failed",
        "response.mcp_list_tools.in_progress",
        "response.output_item.added",
        "response.output_item.done",
        "response.output_text.annotation.added",
        "response.output_text.delta",
        "response.output_text.done",
        "response.queued",
        "response.reasoning_summary_part.added",
        "response.reasoning_summary_part.done",
        "response.reasoning_summary_text.delta",
        "response.reasoning_summary_text.done",
        "response.reasoning_text.delta",
        "response.reasoning_text.done",
        "response.refusal.delta",
        "response.refusal.done",
        "response.web_search_call.completed",
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
    )
)
