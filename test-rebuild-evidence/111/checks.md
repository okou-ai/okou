# Batch 111 verification

## Main synchronization

The opening PR head was `10e42998a931e337c08a02e313bec67f7019523d`. Main was synchronized without conflicts through `9035254d926817b7e74cf3a83a5023999456ec78`. The last merge changed only the presentation-template release manifest, which parsed successfully. The Platform sources, test configuration and dependency lockfile were unchanged by that merge. The Platform change added personal Antigravity subscriptions in Preferences. Its routed suite was included in both Platform runs. The matching six API route tests passed against a separately migrated local PostgreSQL database using synthetic credentials. Other incoming changes covered release versions and native clients. [Preferences and service change](https://github.com/okou-ai/okou/pull/50523)

## Registered scenarios

All 121 tests across 13 affected and protected Platform suites passed in regular order and with shuffle seed 111. The first concurrent local run exceeded three existing case deadlines while the same machine was also running Chromium and type checking. The serial regular rerun and the shuffled run both passed with the configured deadlines. On the first pushed head, lint had renamed two command declarations without updating their callers. The corrected tests bind both public factories to the renamed commands. The archive attached to the PR records the exact registered titles and head-specific CI jobs.

The Router search still sends five successive inputs and validates its final result. The continued checkpoint records the retirement of search-002. Shared scheduling still respects its cancellable zero-delay Vitest branch and its production delay. The attachment suite covers media ordering, playback, pause, resume and advancement to the next recording. [Search decision](https://github.com/okou-ai/okou/commit/090b0c51baf3d980b040220352cec1ae57d634bd) · [Search](../../turbo/apps/platform/src/views/okou-page/__tests__/chat-search-debounce.test.tsx) · [Attachments](../../turbo/apps/platform/src/views/okou-page/__tests__/chat-attachment-message-previews.test.tsx)

## Public observation boundaries

- The independent loopback receiver and Chromium windows used synthetic users and topics. A passive port observer labels the original requests and preserves their delivery. The tagged indicators error was inspected on the Window after deserialization. No test manufactures a private registration or error.
- Router pages establish the observable Clerk, browser-viewer, database and unread outcomes. The marketing handoff validates ownership using the identity of the original user promise when the organization is absent. The replacement control uses the same member and session. [Ownership check](../../turbo/apps/platform/src/signals/prompt-page/marketing-handoff.ts)
- The five original scheduling contracts concern results returned to distinct callers. The caller supplies a command and its own ccstate Store. Platform state and scheduler internals are never inspected. The repository documents this factory API and retains page-level tests for its consumers. A native Chromium replay also exercised the 20 ms debounce and 1,000 ms throttle. [Scheduling API](../../.claude/skills/ccstate/references/lifecycle.md#debounced-and-throttled-commands) · [Platform testing policy](../../docs/app/app-testing.md) · [Caller tests](../../turbo/apps/platform/src/signals/__tests__/command-scheduling.test.ts)
- The [source comparison](comparison.json) lists original owner paths, helper blobs and normalized body fingerprints checked across frozen, both pre-withdrawal trees, opening head and synchronized main. The [case reconciliation](reconciliation.json) verifies the retained owner/GWT pairs and one active anchor per survivor. The per-ID ledger retains the precise pending clause even when another part of the case passed.

Final CI and the replay archive are recorded on [PR #48906](https://github.com/okou-ai/okou/pull/48906).
