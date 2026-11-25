# chat-threads-model-selection

## chat-threads-model-selection-001

- Vitest: "POST /api/chat-threads/:id/model-selection > retains concurrent per-model efforts and publishes adjacent event pairs for each save"
- Mode: run
- Given: An authenticated owner can select Claude Sonnet and personal Luna on one thread.
- When: The owner concurrently saves Sonnet high and standard, and Luna high and Fast, providing separate model and tier event IDs for each save.
- Then: The event feed shows four events. For each save its model and tier events use the supplied IDs, adjacent sequences and equal timestamps. The Sonnet pair carries a null tier and the Luna pair carries priority. Metadata retains both high-effort settings and reflects the final published model and tier.

## chat-threads-model-selection-002

- Vitest: "POST /api/chat-threads/:id/model-selection > deduplicates repeated event IDs and permits a later save with new IDs"
- Mode: run
- Given: An authenticated thread owner can select Claude Opus and Sonnet.
- When: The owner saves Opus extra with two client IDs, repeats with the same IDs and later saves Sonnet high with a new pair of IDs.
- Then: Replay preserves metadata and the event list exactly. The later save appends adjacent model and null-tier events with their supplied IDs, with a two-position sequence gap from the repeated IDs. Metadata selects Sonnet and retains both models' efforts.

## chat-threads-model-selection-003

- Vitest: "POST /api/chat-threads/:id/model-selection > refuses missing, foreign-owned and wrong-org targets without metadata or event effects"
- Mode: run
- Given: A member owns a thread with saved model metadata and published events. Another user shares the workspace and the owner can sign into a different workspace.
- When: The owner targets an unknown thread, the peer targets the owned thread and the owner targets it in the wrong workspace.
- Then: Each model-selection request returns HTTP 404. The caller's feed, the owner's feed and the owned thread metadata all remain unchanged.

## chat-threads-model-selection-004

- Vitest: "POST /api/chat-threads/:id/model-selection > saves and emits actual Codex Fast, preserves it for effort, and resets to standard"
- Mode: run
- Given: An owner can select personal Luna and Claude Sonnet.
- When: The owner sets Luna to Fast, changes Luna effort, then saves without options, supplying event IDs at each step. After restoring Fast, the owner tries switching to Sonnet both with an effort change and with an explicit Fast request.
- Then: The successful metadata stages show priority, priority and null. Each save publishes an adjacent pair carrying the corresponding IDs and tier. Both Sonnet writes return HTTP 400 with "Fast mode is unavailable for this model route", and leave metadata and events unchanged.

## chat-threads-model-selection-005

- Vitest: "POST /api/chat-threads/:id/model-selection > rejects an unavailable personal subscription without mutating selection"
- Mode: run
- Given: A member owns a thread selecting Sonnet and has no connected Luna subscription, but can use personal Opus.
- When: The member tries changing the selection to Luna and then selects Opus.
- Then: Luna returns HTTP 400 directing the caller to select Auto or a connected personal model and leaves Sonnet selected. The accepted Opus change is visible in metadata.

## chat-threads-model-selection-006

- Vitest: "POST /api/chat-threads/:id/model-selection > rejects unsupported effort levels and persists supported ones"
- Mode: run
- Given: An authenticated owner can select Opus and Sonnet.
- When: The owner tries xhigh with each, then saves Sonnet extra and Sonnet ultracode in separate requests.
- Then: Both xhigh requests return HTTP 400 with the unsupported effort message. Each accepted effort is read back under the Sonnet model.

## chat-threads-model-selection-007

- Vitest: "POST /api/chat-threads/:id/model-selection > persists independent model efforts and emits single-model patches"
- Mode: run
- Given: An authenticated member owns a thread and can select Sonnet and Opus.
- When: The member saves Sonnet high, switches to Opus without effort, then saves Opus extra.
- Then: The first Opus selection retains the Sonnet setting and has no Opus effort entry yet. The later metadata contains both Sonnet high and Opus extra, and the event feed includes separate single-model patches.

## chat-threads-model-selection-008

- Vitest: "POST /api/chat-threads/:id/model-selection > preserves each model's effort on a model switch"
- Mode: run
- Given: A member has saved Sonnet extra and can switch the thread to Opus.
- When: The member changes the selected model to Opus without an effort field.
- Then: Metadata selects Opus while retaining Sonnet extra in model settings.

## chat-threads-model-selection-009

- Vitest: "POST /api/chat-threads/:id/model-selection > stores and records the replacement when an old client requests retired claude-fable-5"
- Mode: run
- Given: An old client has a valid workspace Run token and requests retired `claude-fable-5` for an owned thread.
- When: The client submits the selection and reads metadata and thread events.
- Then: The write returns HTTP 204 and the reads return HTTP 200. Metadata and the sole model-selection event use successor `claude-fable-5-1`.

## chat-threads-model-selection-010

- Vitest: "POST /api/chat-threads/:id/model-selection > stores and records the replacement when an old client requests retired claude-sonnet-4-6"
- Mode: run
- Given: An old client has a valid workspace Run token and requests retired `claude-sonnet-4-6` for an owned thread.
- When: The client submits the selection and reads metadata and thread events.
- Then: The write returns HTTP 204 and the reads return HTTP 200. Metadata and the sole model-selection event use successor `claude-sonnet-5-5`.

## chat-threads-model-selection-011

- Vitest: "POST /api/chat-threads/:id/model-selection > stores and records the replacement when an old client requests retired claude-opus-4-8"
- Mode: run
- Given: An old client has a valid workspace Run token and requests retired `claude-opus-4-8` for an owned thread.
- When: The client submits the selection and reads metadata and thread events.
- Then: The write returns HTTP 204 and the reads return HTTP 200. Metadata and the sole model-selection event use successor `claude-opus-5-5`.

## chat-threads-model-selection-012

- Vitest: "POST /api/chat-threads/:id/model-selection > updates thread model selection with an Okou run token carrying chat-thread:write"
- Mode: run
- Given: A workspace member owns a new thread named "Launch plan" and has a Run token with `chat-thread:write`.
- When: The member selects Sonnet with that token and gets thread metadata.
- Then: The write returns HTTP 204 and metadata HTTP 200 returns the thread ID, title, Sonnet selection, empty model settings, null pin, tier and computer-use host, false archive, hidden and muted flags, and cloud browser enabled.
