# teams-route-ownership

## teams-route-ownership-001

- Vitest: "Teams route ownership through public ingress > creates one durable thread and reuses it for distinct and repeated activities"
- Mode: run
- Given: A connected Teams member can mention the bot in a fixed channel thread.
- When: Teams delivers the first signed message, then a different activity for the same thread and a replay of that second activity.
- Then: The member reads exactly one new durable Okou thread, with no extra creation event after the later deliveries. Its stored input rows contain the two distinct texts `@Nova first route message` and `@Nova second route message` once each.

## teams-route-ownership-002

- Vitest: "Teams route ownership through public ingress > keeps the same external channel and thread isolated between connected identities"
- Mode: run
- Given: Two Teams identities linked to distinct Okou users can send from the same Teams channel and external thread.
- When: Each identity sends a signed bot mention to that thread and reads their corresponding Okou thread. The second identity also requests events from the first identity's thread.
- Then: Each account gets a different Okou thread with one input, and the cross-account read returns HTTP 404.

## teams-route-ownership-003

- Vitest: "Teams route ownership through public ingress > reuses a personal thread when Teams changes the conversation destination"
- Mode: run
- Given: A connected Teams member has a personal conversation under one Teams destination and a Runner can execute the resulting runs.
- When: The member sends signed personal activities under two successive conversation IDs, and the Runner ends the first run, then the launched second run.
- Then: The member sees one unchanged Okou thread with two inputs and two launched runs. Teams receives the second activity's terminal reply at its new destination and never at the previous destination.

## teams-route-ownership-004

- Vitest: "Teams route ownership through public ingress > converges overlapping public messages onto one thread without losing either input"
- Mode: run
- Given: A connected Teams user can send to a channel thread with no prior input from the scenario.
- When: Teams posts two distinct signed message activities to the same thread concurrently.
- Then: Reading the user's creation events returns one Okou thread, and its input rows contain both overlapping prompts.
