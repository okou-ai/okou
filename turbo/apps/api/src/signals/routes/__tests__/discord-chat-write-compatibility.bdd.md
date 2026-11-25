# discord-chat-write-compatibility

## discord-chat-write-compatibility-001

- Vitest: "Discord chat-write rollout compatibility > posts the Discord reply once when the runner repeats its terminal callback"
- Mode: run
- Given: A connected Discord user mentions the installed bot in a guild channel. The resulting conversation contains one admitted prompt for a run assigned to a Runner.
- When: The Runner submits the same failed completion three times to `POST /api/webhooks/run/complete` using the run's sandbox bearer token.
- Then: Each callback returns HTTP 200. The conversation contains exactly one `run.failed` event, and Discord receives one reply associated with the original message. The reply contains the safe error from the event and omits the Runner's internal error text.
