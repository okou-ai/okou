# Chat composer model panel

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-model-panel.test.tsx](chat-composer-model-panel.test.tsx).

## chat-composer-model-panel-001

Original test `Auto hides the model picker until a subscription adds models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L105).

- **Given** A new chat is in Auto mode and no subscription models are available.
- **When** The composer loads.
- **Then** The model picker trigger is hidden.

## chat-composer-model-panel-002

Original test `Auto shows the model picker once a subscription adds models`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L111).

- **Given** A new chat is in Auto mode and a connected subscription provides GPT 6 Sol.
- **When** The composer loads.
- **Then** The Auto model picker trigger appears.

## chat-composer-model-panel-003

Original test `Show the final model groups before subscription usage resolves`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L118).

- **Given** A new chat has GPT 6 Astra available and subscription usage is still loading; subscription linking is enabled.
- **When** The user opens the Auto model panel, then subscription usage resolves with 88% remaining.
- **Then** Before usage resolves, the panel shows the GPT 6 Astra model, ChatGPT and Claude plan groups, Connect, Manage plans, and a loading indicator. After resolution, it shows 88% left, retains the same ChatGPT plan group and model options, and removes the loading indicator.

## chat-composer-model-panel-004

Original test `Choose a connected subscription model, return to Auto and send Auto`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L171).

- **Given** A new chat starts in Auto mode with connected subscription model GPT 6 Sol available.
- **When** The user selects GPT 6 Sol, returns to Auto, and sends “Run this on Auto.”
- **Then** The new chat is created with a null model selection, representing Auto.

## chat-composer-model-panel-005

Original test `Pick only chat models, with effort and Fast in the same panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L198).

- **Given** A new chat offers GPT 5.6 Sol and Claude Sonnet 5, with GPT 5.6 Sol selected.
- **When** The user opens the model panel.
- **Then** The Chat models list contains the selectable chat models, and the panel also shows an Effort control with Lower usage and Higher usage labels and a 2.5× subscription usage indicator for Fast mode. The model list scroll area excludes the Effort control.

## chat-composer-model-panel-006

Original test `Keep the panel open while changing effort, Fast and model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L224).

- **Given** A new chat offers GPT 5.6 Sol and Claude Sonnet 5, with GPT 5.6 Sol initially at Max effort.
- **When** The user lowers effort, enables Fast, then selects Claude Sonnet 5.
- **Then** The panel stays open during each change. The GPT trigger reflects Low effort and Fast; Claude Sonnet 5 becomes selected at High effort, and Fast mode is no longer offered for Claude.

## chat-composer-model-panel-007

Original test `Keep the model panel usable as the temporary model notice appears and clears`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L254).

- **Given** A new chat offers GPT 6 Astra and GPT 6.1 Sol, with GPT 6 Astra selected and no temporary model notice.
- **When** The user selects GPT 6.1 Sol, then switches back to GPT 6 Astra and closes the panel.
- **Then** The temporary notice appears for GPT 6.1 Sol while the panel remains open and its Effort and Fast controls are enabled. Switching back removes the notice, selects GPT 6 Astra, and keeps the panel open; after closing it, the GPT 6 Astra trigger has focus.

## chat-composer-model-panel-008

Original test `Send with the model and effort chosen in the panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L286).

- **Given** A new chat offers GPT 5.6 Sol and Claude Sonnet 5, with GPT 5.6 Sol initially selected.
- **When** The user selects Claude Sonnet 5, lowers its effort, and sends “Run this on Sonnet.”
- **Then** The chat is created with model Claude Sonnet 5 and reasoning effort low.

## chat-composer-model-panel-009

Original test `Name the model and its effort on the trigger, with a bolt for Fast`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L320).

- **Given** A new chat offers GPT 5.6 Sol, initially at Max effort and not in Fast mode.
- **When** The user opens the model panel and enables Fast mode.
- **Then** The trigger names GPT 5.6 Sol and Max effort, and displays a bolt only after Fast mode is enabled.

## chat-composer-model-panel-010

Original test `Select Ultrafast in the composer for a Codex model that offers it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-panel.test.tsx#L333).

- **Given** A new chat has Codex model GPT 6.1 Sol selected, and the model offers Standard, Fast, and Ultrafast speeds.
- **When** The user opens the model panel and selects Ultrafast.
- **Then** Ultrafast becomes the selected speed, and the panel explains that it uses more of the user's Codex allowance.
