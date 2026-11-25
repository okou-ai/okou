# member-memory-initialization

## member-memory-initialization-001

- Vitest: "member memory account initialization > mounts the same Memory in first Runs that both observed an uninitialized member"
- Mode: run
- Given: An organization member whose Memory is not yet initialized (preferences saved with `POST /api/user-preferences`) has a personal subscription model and a funded workspace. Storage verification of their first Run's attached file is held while it checks the file.
- When: The member sends a first chat Run with an attached text file; while its attachment check is held, the member starts a second first Run without an attachment, which the Runner picks up; then the held check completes.
- Then: Both Runs' execution storage manifests have exactly the same single mount: `memory`, empty, writeback enabled, missing-root policy `preserveParentVersion`, with a version ID equal to the empty-content hash of its storage ID. `GET /api/user-preferences` then reports `memoryInitialized` true.

## member-memory-initialization-002

- Vitest: "member memory account initialization > initializes and replays memory through authenticated org:admin preferences"
- Mode: run
- Given: An organization admin saved preferences (timezone UTC, locale en-US) without initializing Memory.
- When: The admin calls `POST /api/user-preferences/initialize` with Asia/Tokyo and ja-JP, replays it with other values, reads preferences, starts a Run, calls initialize again with only a locale, and starts another Run.
- Then: The first initialize returns `memoryInitialized` true with the existing timezone `UTC` and locale `en-US`, and the replay returns exactly the same body. Preferences report Memory initialized. The first Run mounts one empty `memory` storage whose version is the empty-content hash, and the second Run mounts the same storage and version.

## member-memory-initialization-003

- Vitest: "member memory account initialization > initializes and replays memory through authenticated org:member preferences"
- Mode: run
- Given: An organization member saved preferences (timezone UTC, locale en-US) without initializing Memory.
- When: The member calls `POST /api/user-preferences/initialize` with Asia/Tokyo and ja-JP, replays it with other values, reads preferences, starts a Run, calls initialize again with only a locale, and starts another Run.
- Then: The first initialize returns `memoryInitialized` true with the existing timezone `UTC` and locale `en-US`, and the replay returns exactly the same body. Preferences report Memory initialized. The first Run mounts one empty `memory` storage whose version is the empty-content hash, and the second Run mounts the same storage and version.

## member-memory-initialization-004

- Vitest: "member memory account initialization > shares one memory across concurrent onboarding and membership delivery"
- Mode: run
- Given: An organization member saved preferences without initializing Memory.
- When: The member completes `POST /api/onboarding/complete` while a signed Clerk `organizationMembership.created` webhook is delivered concurrently to `POST /api/webhooks/clerk`; the member starts a Run; both deliveries are repeated; the member starts another Run.
- Then: Both deliveries succeed and preferences report Memory initialized. The first Run mounts an empty `memory` storage, and the later Run mounts the same storage ID and version.

## member-memory-initialization-005

- Vitest: "member memory account initialization > synchronously initializes one memory for duplicate org:admin onboarding completions"
- Mode: run
- Given: An organization admin saved preferences without initializing Memory.
- When: The admin calls `POST /api/onboarding/complete` twice concurrently, starts a Run, completes onboarding again, and starts another Run.
- Then: Both completions succeed and Memory is reported initialized. The first Run mounts an empty `memory` storage with a storage ID and version, and after the repeated completion the next Run mounts the same storage ID and version.

## member-memory-initialization-006

- Vitest: "member memory account initialization > synchronously initializes one memory for duplicate org:member onboarding completions"
- Mode: run
- Given: An organization member saved preferences without initializing Memory.
- When: The member calls `POST /api/onboarding/complete` twice concurrently, starts a Run, completes onboarding again, and starts another Run.
- Then: Both completions succeed and Memory is reported initialized. The first Run mounts an empty `memory` storage with a storage ID and version, and after the repeated completion the next Run mounts the same storage ID and version.

## member-memory-initialization-007

- Vitest: "member memory account initialization > initializes memory on a membership webhook without Web onboarding"
- Mode: run
- Given: An organization member saved preferences without initializing Memory and never completes Web onboarding.
- When: A signed Clerk `organizationMembership.created` webhook is delivered to `POST /api/webhooks/clerk`, delivered again, the member starts a Run, the webhook is delivered a third time, and the member starts another Run.
- Then: Memory is reported initialized after the first delivery and still after the replay. The first Run mounts an empty `memory` storage, and the later Run mounts the same storage ID and version.

## member-memory-initialization-008

- Vitest: "member memory account initialization > isolates memory by both organization and user"
- Mode: run
- Given: A member, the same user in another organization, and another member of the first organization each saved preferences without initializing Memory.
- When: Each completes `POST /api/onboarding/complete` and starts a Run.
- Then: Each is reported Memory initialized and each Run mounts an empty Memory. The three storage IDs are distinct and the three version IDs are distinct.

## member-memory-initialization-009

- Vitest: "member memory account initialization > preserves publication racing a membership initialization replay"
- Mode: run
- Given: A funded organization member has initialized Memory and a running Run that writes `memory.md`.
- When: The Run publishes its Memory through the storage prepare and commit webhooks while a Clerk `organizationMembership.created` webhook for the member is delivered concurrently; then a new Run starts.
- Then: The new Run's Memory has the writer's storage ID, the published version ID and an archive URL. Downloading the archive returns HTTP 200 with exactly the published `memory.md` archive.

## member-memory-initialization-010

- Vitest: "member memory account initialization > preserves published memory when either initialization entry is repeated"
- Mode: run
- Given: A funded organization member has initialized Memory and a running Run.
- When: The Run publishes `memory.md` with `POST /api/webhooks/run/storages/prepare` and `POST /api/webhooks/run/storages/commit`; the member then completes `POST /api/onboarding/complete` and a Clerk `organizationMembership.created` webhook is delivered; then a new Run starts.
- Then: The commit returns the prepared version ID and file count 1. The new Run mounts the same storage ID and published version with an archive URL and no `empty` flag. The downloaded archive equals the published archive and contains `memory.md` with the written content.
