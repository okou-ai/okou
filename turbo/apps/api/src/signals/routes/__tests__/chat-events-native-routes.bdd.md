# chat-events-native-routes

## chat-events-native-routes-001

- Vitest: "personal native subscription activation > uses the personal Claude schedule Automation handoff and completion"
- Mode: run
- Given: An authenticated Pro workspace member has personal Claude Fable 5.1 and owns a loop automation with a one-hour interval.
- When: The member manually starts the automation and the Sandbox completes the resulting Run.
- Then: Launch returns HTTP 201 with a thread ID. Dispatch uses Claude Code with a nonempty Claude OAuth reference and no Pi model config. Run readback shows member-scoped Claude OAuth and completes. The thread has exactly one completed terminal event and zero model credits.

## chat-events-native-routes-002

- Vitest: "personal native subscription activation > uses the personal Claude event Automation handoff and completion"
- Mode: run
- Given: An authenticated Team workspace member has personal Claude Fable 5.1 and an owned signed webhook automation.
- When: The provider posts the same signed event twice, then the Sandbox completes the resulting Run.
- Then: The first response reports duplicate false, and replay reports duplicate true. Dispatch uses Claude Code with a nonempty Claude OAuth reference and no Pi model config. Run readback shows member-scoped Claude OAuth and completes. The thread has exactly one completed terminal event and zero model credits.

## chat-events-native-routes-003

- Vitest: "personal native subscription activation > keeps official Claude member subscription credentials on Claude Code with Pi enabled"
- Mode: run
- Given: An entitled workspace member has official personal Claude Fable 5.1 available with Pi enabled.
- When: The member sends a Chat prompt with Claude Fable 5.1 and the Runner claims it.
- Then: The dispatch uses Claude Code and a nonempty Claude OAuth credential reference and has no Pi model config.
