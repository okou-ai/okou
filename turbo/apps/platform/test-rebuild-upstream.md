# Upstream App test reconciliation

Compared the frozen baseline b0a10287edf42 with main 4b72b660f8279424182640658aa21773cc49ccd4. All 13 changes are modifications to existing paths. The 5,111 frozen scenario IDs stay available for net-reduction accounting. This supplement records changed behavior and two additional cases before clearing the incoming legacy bodies.

## bootstrap-feature-switch

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/signals/__tests__/bootstrap-feature-switch.test.tsx) · [Frozen BDD](src/signals/__tests__/bootstrap-feature-switch.bdd.md)

Keep signed-out behavior, blocked startup until authoritative switches arrive, and upgrade-required feedback. The guide-ID request/count assertion was dropped. The old no-override redirect case (bootstrap-feature-switch-004) was deleted upstream and goes to screening for retirement.

Frozen IDs nearest changed declaration ranges for audit. Shared fixture or helper changes also apply wherever that boundary is used. bootstrap-feature-switch-002, bootstrap-feature-switch-003

## agent-suggestions

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/agent-suggestions.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/agent-suggestions.bdd.md)

Paused automation cards use Automation paused and System update. Keep mixed-deck and unread-until-open behavior.

Frozen IDs nearest changed declaration ranges for audit. agent-suggestions-041, agent-suggestions-046

## chat-artifact-action-group

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-artifact-action-group.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-artifact-action-group.bdd.md)

When switching the sidebar to another chat, await the new preview and its correct content together after the metadata becomes available.

Frozen IDs nearest changed declaration ranges for audit. chat-artifact-action-group-001

## chat-capability-voice-forwarding

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-voice-forwarding.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-capability-voice-forwarding.bdd.md)

Await the Forward to dialog becoming available before interacting with it.

Frozen IDs nearest changed declaration ranges for audit. chat-capability-voice-forwarding-001

## chat-composer-chat-connector-access

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-chat-connector-access.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-composer-chat-connector-access.bdd.md)

Wait for the open connector directory with its heading before interacting. Apply the same readiness contract to both parameter rows.

Frozen IDs nearest changed declaration ranges for audit. Shared fixture or helper changes also apply wherever that boundary is used. chat-composer-chat-connector-access-001, chat-composer-chat-connector-access-002

## chat-composer-connector-scroll

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-scroll.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-composer-connector-scroll.bdd.md)

When closing and reopening an incompletely loaded directory, await the trigger reporting collapsed before reopening.

Frozen IDs nearest changed declaration ranges for audit. chat-composer-connector-scroll-004

## chat-composer-connector-status

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-connector-status.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-composer-connector-status.bdd.md)

Wait for the newly reopened connector directory after custom account connection; its fresh state remains the observable result.

Frozen IDs nearest changed declaration ranges for audit. chat-composer-connector-status-004

## chat-composer-ssh

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-ssh.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-composer-ssh.bdd.md)

Wait for Remote access dialog readiness and for Off and On results after the respective changes. Await the actual directory dialog after navigating shelves and categories.

Frozen IDs nearest changed declaration ranges for audit. chat-composer-ssh-005, chat-composer-ssh-014, chat-composer-ssh-018

## chat-selection-actions

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-selection-actions.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-selection-actions.bdd.md)

Await Forward to before selecting a destination after native selection collapses; retain captured-passage intent.

Frozen IDs nearest changed declaration ranges for audit. chat-selection-actions-004

## chat-send-read-status

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/chat-send-read-status.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/chat-send-read-status.bdd.md)

Wait for Forward to before sending; retain dismissal before unread refresh or send completes.

Frozen IDs nearest changed declaration ranges for audit. chat-send-read-status-004

## platform-feed-events

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/platform-feed-events.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/platform-feed-events.bdd.md)

The linked route now opens directly in a new tab. Preserve fast versus pending loading and exact automation focus without mutation. Present the pause reason, description, System update label, local timestamp and secure new-tab link. Retain dismissal retry and add the two Enable outcomes below.

Frozen IDs nearest changed declaration ranges for audit. Shared fixture or helper changes also apply wherever that boundary is used. platform-feed-events-001, platform-feed-events-002, platform-feed-events-004, platform-feed-events-012, platform-feed-events-013

## projects

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/projects.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/projects.bdd.md)

Wait for the source chat to become draggable before dragging across Agents into a collapsed project.

Frozen IDs nearest changed declaration ranges for audit. projects-035

## remote-connection-order

[Upstream source](https://github.com/okou-ai/okou/blob/4b72b660f8279424182640658aa21773cc49ccd4/turbo/apps/platform/src/views/okou-page/__tests__/remote-connection-order.test.tsx) · [Frozen BDD](src/views/okou-page/__tests__/remote-connection-order.bdd.md)

Wait for Remote access dialog readiness in both parameter rows before exercising the handed-off connection ordering.

Frozen IDs nearest changed declaration ranges for audit. remote-connection-order-003, remote-connection-order-004

## Upstream additions

### upstream-platform-feed-events-001

Original test: Enable keeps the update available after rejection and clears it after enabling the linked automation.

- **Given** A pause update links to a disabled automation and a sibling automation is already enabled.
- **When** The member enables the linked automation, receives a rejection, and retries.
- **Then** The first failure keeps the update actionable. During retry the card shows busy state and disables dismissal. Success clears the card after the exact linked automation is enabled and leaves the sibling enabled.

### upstream-platform-feed-events-002

Original test: Enable closes an update for a recovered automation without restarting it.

- **Given** An automation has recovered since its pause update was created.
- **When** The member opens the update and selects Enable.
- **Then** The stale update clears and the already recovered automation is left running without a restart.
