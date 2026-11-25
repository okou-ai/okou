# chat-events-effort

## chat-events-effort-001

- Vitest: "CHAT effort: thread configuration > dispatches gpt-6-luna with xhigh as the default Pi effort"
- Mode: run
- Given: An entitled workspace member selects personal GPT-6 Luna on a thread without a saved reasoning setting.
- When: The member sends a prompt and its Runner claims the Run.
- Then: The dispatch applies Luna's `xhigh` default in both the platform reasoning field and the Pi thinking configuration.

## chat-events-effort-002

- Vitest: "CHAT effort: thread configuration > applies requested and saved native effort through the execution protocol"
- Mode: run
- Given: An entitled member can use Fable and Astra. An existing Fable thread is saved at high effort.
- When: The member sends on the Fable thread with no explicit setting, starts a thread with explicit extra effort, and sends on the original thread overriding the model to Astra.
- Then: Dispatch uses high for saved Fable and extra for the explicit request. The new thread stores Fable extra. The Astra override uses max by default and persists Astra as selected while still retaining the original Fable high setting.

## chat-events-effort-003

- Vitest: "CHAT effort: thread configuration > falls back from unavailable gpt-6-sol ultra without deleting the preference"
- Mode: run
- Given: A member selects personal GPT-6 Sol, whose Pi route does not support requested ultra effort.
- When: The member first sends with explicit ultra and later sends with ultra saved on the thread.
- Then: Both dispatches use max in the platform and Pi thinking fields, while metadata preserves the requested Sol ultra preference.

## chat-events-effort-004

- Vitest: "CHAT effort: thread configuration > falls back from unavailable claude-fable-5-1 ultracode without deleting the preference"
- Mode: run
- Given: A member selects personal Claude Fable 5.1, whose native route does not support requested ultracode effort.
- When: The member first sends with explicit ultracode, then saves ultracode on the thread and sends again.
- Then: Both dispatches use max and thread metadata retains the requested Fable ultracode setting.

## chat-events-effort-005

- Vitest: "CHAT effort: thread configuration > preserves enqueued settings after thread edits and retries with Pi false and high effort"
- Mode: run
- Given: A Fable Run is active and the thread is set to Fable high.
- When: The member queues a prompt, edits Fable effort to extra, retries with the same client ID and cancels the active Run.
- Then: Both sends return HTTP 201. The feed has one queued input and one promoted replacement, whose model annotation is Fable. Dispatch retains high with no Fast tier and thread metadata still shows Fable extra and no tier.

## chat-events-effort-006

- Vitest: "CHAT effort: thread configuration > preserves enqueued settings after thread edits and retries with Pi true and high effort"
- Mode: run
- Given: A Fable Run is active and the member sets the thread to personal GPT-6 Sol in Pi, high effort and Fast.
- When: The member queues a prompt, switches the thread to Fable extra and Standard, retries under the same client ID with extra, then cancels the first Run.
- Then: Both sends return HTTP 201. Exactly one replacement launches with the Sol model and priority annotation. Pi dispatch still uses Sol with high and Fast. Thread metadata stays on Fable with no tier and saves Fable extra and Sol high.

## chat-events-effort-007

- Vitest: "CHAT effort: thread configuration > preserves enqueued settings after thread edits and retries with Pi true and ultra effort"
- Mode: run
- Given: A Fable Run is active and the thread is set to Pi GPT-6 Sol, unsupported ultra effort and Fast.
- When: The member queues a prompt, edits the thread to Fable extra and Standard, retries under the same client ID and then frees the active slot.
- Then: Both sends return HTTP 201 and the feed contains one queued input and one promoted replacement with Sol and priority annotation. Runner dispatch keeps Fast and falls back to max effort. Thread metadata remains Fable with null tier and keeps Sol ultra alongside Fable extra.

## chat-events-effort-008

- Vitest: "CHAT effort: thread configuration > preserves enqueued settings after thread edits and retries with Pi false and ultracode effort"
- Mode: run
- Given: A Fable Run is active and the thread is set to Fable with unsupported ultracode effort.
- When: The member queues a prompt, edits Fable effort to extra, retries under the same client ID and cancels the first Run.
- Then: Both requests return HTTP 201. The feed has one queued input and one promoted replacement with Fable annotation. Its dispatch falls back to max, with no Fast tier. Metadata stays on Fable extra with no tier.

## chat-events-effort-009

- Vitest: "CHAT effort: thread configuration > offers Fast on the direct OpenAI Astra route"
- Mode: run
- Given: A member selects direct native OpenAI Astra and the thread starts on Standard.
- When: The member selects Fast, reads metadata, then clears the tier and reads again.
- Then: Thread metadata reports null tier initially, priority after the Fast selection, and null again after clearing it.

## chat-events-effort-010

- Vitest: "CHAT effort: thread configuration > preserves Fast when changing effort"
- Mode: run
- Given: A member selects native OpenAI Astra with Fast and low reasoning effort.
- When: The member sends one turn with saved effort and another with an explicit ultra override.
- Then: The first dispatch uses Fast and low. The second keeps Fast and uses ultra. Metadata saves Astra ultra while retaining priority tier.
