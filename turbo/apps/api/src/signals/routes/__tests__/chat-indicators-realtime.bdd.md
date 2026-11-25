# chat-indicators-realtime

## chat-indicators-realtime-001

- Vitest: "chat indicator realtime signal > signals a Run start and its terminal marker but not its output"
- Mode: run
- Given: An authenticated workspace owner starts a Claude Fable 5.1 Run on a new Chat thread, with access to Sandbox callbacks and realtime subscriptions.
- When: The owner launches the Run, the Sandbox reports initialized and assistant output events, then reports successful terminal completion.
- Then: Launch emits one `chatIndicatorsChanged` signal. The HTTP 200 output callback emits a thread-message notification without an indicator signal. The HTTP 200 terminal callback emits one indicator signal and Run readback reports completed.

## chat-indicators-realtime-002

- Vitest: "chat indicator realtime signal > signals a cancelled Run's terminal marker"
- Mode: run
- Given: An authenticated workspace owner has submitted a Chat Run.
- When: The owner cancels it before a Runner starts it.
- Then: Cancellation returns HTTP 200, publishes exactly one `chatIndicatorsChanged` signal, and the Run reads back as cancelled.
