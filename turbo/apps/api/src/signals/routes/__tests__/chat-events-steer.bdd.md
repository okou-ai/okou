# chat-events-steer

## chat-events-steer-001

- Vitest: "CHAT-02: steering input prompts into a running run > renders website steering from current settings after starting disabled=false"
- Mode: run
- Given: A workspace member starts a Run while image generation is enabled and queues a Black Slabs website template request containing literal image CLI text.
- When: The member disables image generation and the Sandbox polls, then reenables it and the Sandbox polls again and repeats before acknowledging.
- Then: The disabled render retains the website template, user text and publishing guidance but omits the image workflow. The enabled render includes the complete Black Slabs instructions and image workflow. Both use the original event ID and keep the literal command and template marker. A repeated read matches that setting, the Run's initial prompt stays fixed and the post-acknowledgement poll is empty.

## chat-events-steer-002

- Vitest: "CHAT-02: steering input prompts into a running run > renders illustration steering from current settings after starting disabled=false"
- Mode: run
- Given: A workspace member starts a Run with image generation enabled and queues an Emboss & Deboss illustration template request with literal image CLI text.
- When: The member disables image generation and the Sandbox polls, reenables it and polls twice, then acknowledges.
- Then: The disabled render keeps template identity and literal user text without style-source execution guidance. The enabled render provides the full style resource and compilation guidance. Repeating the poll retains that render and event ID, while the original Run prompt stays fixed and the final poll is empty.

## chat-events-steer-003

- Vitest: "CHAT-02: steering input prompts into a running run > renders website steering from current settings after starting disabled=true"
- Mode: run
- Given: A workspace member starts a Run with image generation disabled and queues a Black Slabs website template request containing literal image CLI text.
- When: The member enables image generation and the Sandbox polls, then disables it again, polls twice and acknowledges.
- Then: The first render includes the complete Black Slabs instructions and image workflow. The latter renders omit only that workflow while retaining the original user text, template marker and publishing guidance. The Run's original prompt is unchanged and polling is empty after acknowledgement.

## chat-events-steer-004

- Vitest: "CHAT-02: steering input prompts into a running run > renders illustration steering from current settings after starting disabled=true"
- Mode: run
- Given: A workspace member starts a Run with image generation disabled and queues an Emboss & Deboss illustration template request with literal image CLI text.
- When: The member enables image generation and the Sandbox polls, disables it again, polls twice more and acknowledges the event.
- Then: The enabled render contains full style resource and compilation guidance. Both disabled reads keep only template identity above the original text and marker, and all reads identify the same event. The Run's original prompt is unchanged and the last poll after acknowledgement has no input.

## chat-events-steer-005

- Vitest: "CHAT-02: steering input prompts into a running run > steers Document input with its pinned source before the next queued prompt"
- Mode: run
- Given: A member has an active Chat Run and selects the pinned Simple Invoice document template for the first of two queued prompts.
- When: The member sends both and the Sandbox polls, acknowledges the document input and polls again.
- Then: The public queued event preserves the structured document request. The first delivery names the prompt and exact version-pinned invoice source URL. Acknowledgement returns HTTP 200 and the next poll returns the second event ID and original summary prompt.

## chat-events-steer-006

- Vitest: "CHAT-02: steering input prompts into a running run > includes cover guidance for a template steered into an existing run"
- Mode: run
- Given: A member has an active Run and submits a website template request for steering into it.
- When: The Sandbox polls for the request.
- Then: The delivery includes the website prompt and instructions to capture a hosted cover screenshot and publish with the preview.

## chat-events-steer-007

- Vitest: "CHAT-02: steering input prompts into a running run > returns the next prompt after the run's own input and declares it steered once"
- Mode: run
- Given: A member has a Run active with its own bound input, then queues two further prompts.
- When: The Sandbox polls before and after enqueue, concurrently acknowledges the head twice, then acknowledges the second and eventually repeats the first acknowledgement.
- Then: The original bound input is never delivered for steering. Reads expose the pending head repeatedly, concurrent and replayed declarations return `steered`, the second appears once the head is consumed, and the final poll is null. History contains one replacement per queued event tied to the active Run.

## chat-events-steer-008

- Vitest: "CHAT-02: steering input prompts into a running run > skips recalled prompts and rejects unknown input"
- Mode: run
- Given: A member has an active Run and two queued prompts.
- When: The Sandbox tries declaring an unknown ID, polls the head and attempts to declare it after the member recalls it. The Sandbox then acknowledges the remaining input twice.
- Then: The unknown ID returns HTTP 404, recall returns HTTP 201, and late declaration of the recalled head returns an already-consumed conflict. The remaining prompt is delivered and both declarations return `steered`; final polling returns null. History has only a revoke for the recalled prompt and exactly one launched replacement for the other.

## chat-events-steer-009

- Vitest: "CHAT-02: steering input prompts into a running run > rejects a declaration once the run ended and another run took the prompt"
- Mode: run
- Given: An active Run's Sandbox has read a queued prompt but has not acknowledged it.
- When: The Sandbox completes and a successor takes the queued prompt. The original Sandbox polls and attempts a late acknowledgement.
- Then: The original poll returns null and its late declaration returns HTTP 409 indicating that the Run is no longer running. The event feed contains exactly one replacement belonging to the successor.

## chat-events-steer-010

- Vitest: "CHAT-02: steering input prompts into a running run > accepts only the run's own sandbox token"
- Mode: run
- Given: A member has an active Run with queued input and credentials for a CLI token and another Sandbox Run in another thread.
- When: Clients poll or declare with no authentication, the CLI token, the other Run's token, and the active Run's own token.
- Then: Missing auth returns HTTP 401. The CLI token and another Run's token cannot steer this Run and receive HTTP 403 on tested accesses. Declaring the foreign input through the other Run's own endpoint returns HTTP 404. The owning token receives the exact prompt and event ID, acknowledges twice as steered, then sees an empty poll and one replacement tied to its Run.
