# Subscription linking

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [subscription-linking.test.tsx](subscription-linking.test.tsx).

## subscription-linking-001

Original test `An unlinked member finds the subscriptions in the composer's model slot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L135).

- **Given** A member has no linked third-party subscriptions and is composing a chat.
- **When** The member opens the composer's model menu.
- **Then** The menu shows Auto as using Okou credits, offers ChatGPT (Codex) for Plus, Pro, or Business and Claude for Pro or Max, and includes the Run on your own plan entry. Explore Okou capabilities is also available.

## subscription-linking-002

Original test `Codex opens its authorization from the composer and the slot becomes the model picker after confirmation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L158).

- **Given** A member is composing a message with no linked subscriptions and has typed “Keep this draft”.
- **When** The member starts Codex authorization from the composer and confirms the pending authorization.
- **Then** The authorization dialog closes, the composer returns to the Auto model control, and the draft text remains. The Use more models entry is no longer available in the composer or account menu.

## subscription-linking-003

Original test `Linking one subscription keeps the other one connectable from the model panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L209).

- **Given** A member has linked ChatGPT but not Claude and opens the model panel.
- **When** The member chooses Claude from the panel.
- **Then** The panel shows the ChatGPT and Claude plans, including ChatGPT usage with 0% left in 5 hours, and Claude authorization begins.

## subscription-linking-004

Original test `Manage plans in the model panel opens Models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L233).

- **Given** A member with linked ChatGPT is viewing the model panel.
- **When** The member chooses Manage plans.
- **Then** The Models settings view opens.

## subscription-linking-005

Original test `Claude opens its authorization from the account menu and cancelling keeps both entries`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L243).

- **Given** A member has no linked subscriptions and opens the account menu.
- **When** The member opens Use more models, starts Claude authorization, then closes its dialog.
- **Then** The authorization dialog shows the Claude authorization link and closes. Use more models remains available afterward.

## subscription-linking-006

Original test `Linked members get the model picker and no linking entry (needsReconnect=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L284).

- **Given** A member has a linked Codex subscription that does not need reconnection.
- **When** The member opens the composer model menu and account menu, then visits subscription usage.
- **Then** The model picker is available and Use more models is absent from both menus. ChatGPT usage opens.

## subscription-linking-007

Original test `Linked members get the model picker and no linking entry (needsReconnect=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L284).

- **Given** A member has a linked Codex subscription marked as needing reconnection.
- **When** The member opens the composer model menu and account menu, then visits subscription usage.
- **Then** The model picker is available and Use more models is absent from both menus. ChatGPT usage opens.

## subscription-linking-008

Original test `The subscription linking switch keeps capability discovery available`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L307).

- **Given** Subscription linking is disabled and the member has no linked subscriptions.
- **When** The member opens the account menu while composing a chat.
- **Then** Use more models is absent, while Explore Okou capabilities remains available.

## subscription-linking-009

Original test `The feature switch leaves a linked member's model panel ungrouped`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L315).

- **Given** Subscription linking is disabled and the member has a linked Codex subscription.
- **When** The member opens the model panel.
- **Then** GPT 6 Astra is available without a Your ChatGPT plan grouping or a Manage plans action.

## subscription-linking-010

Original test `An unresolved subscription lookup offers no entry yet`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L324).

- **Given** The member's subscription lookup is still pending and no subscriptions have been returned yet.
- **When** The member opens the account menu, then the lookup completes with no subscriptions.
- **Then** Use more models is absent while the lookup is unresolved and appears after the empty result arrives.

## subscription-linking-011

Original test `The mobile Me page offers both subscriptions and opens the chosen sign-in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L344).

- **Given** A member with no linked subscriptions is on the mobile Me page.
- **When** The member opens Use more models and chooses Claude.
- **Then** The menu offers ChatGPT (Codex) and Claude, and Claude authorization begins.

## subscription-linking-012

Original test `The mobile Me entry leaves once a subscription is linked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L373).

- **Given** A member with a linked Codex subscription is on the mobile Me page.
- **When** The member views the page.
- **Then** ChatGPT usage is available and Use more models is absent.

## subscription-linking-013

Original test `The shared switch also removes the mobile Me entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/subscription-linking.test.tsx#L383).

- **Given** Subscription linking is disabled and a member with no linked subscriptions is on the mobile Me page.
- **When** The member views the page.
- **Then** Use more models is absent.
