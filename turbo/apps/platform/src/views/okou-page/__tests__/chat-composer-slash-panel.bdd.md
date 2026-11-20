# Chat composer slash panel

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-slash-panel.test.tsx](chat-composer-slash-panel.test.tsx).

## chat-composer-slash-panel-001

Original test `Keep slash search and template browsing available for Unicode query 网站`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L138).

- **Given** The composer contains a slash query with the Unicode text “网站.”
- **When** The user browses all templates.
- **Then** The template picker opens with a Website tab, and the slash token is removed from the draft.

## chat-composer-slash-panel-002

Original test `Keep slash search and template browsing available for Unicode query ウェブサイト`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L138).

- **Given** The composer contains a slash query with the Unicode text “ウェブサイト.”
- **When** The user browses all templates.
- **Then** The template picker opens with a Website tab, and the slash token is removed from the draft.

## chat-composer-slash-panel-003

Original test `Keep slash search and template browsing available for Unicode query café`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L138).

- **Given** The composer contains a slash query with the decomposed Unicode text “café.”
- **When** The user browses all templates.
- **Then** The template picker opens with a Website tab, and the slash token is removed from the draft.

## chat-composer-slash-panel-004

Original test `The Templates overview keeps illustration proportions and 16:9 deck covers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L156).

- **Given** The Templates overview is open.
- **When** The user previews Presentation and then Illustration.
- **Then** Presentation covers use a 234-pixel height. Illustration covers use a 416-pixel width without a fixed height and retain the illustration's own aspect ratio.

## chat-composer-slash-panel-005

Original test `The Templates overview previews the complete website catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L181).

- **Given** The Templates overview is open.
- **When** The user previews Website templates.
- **Then** The Website preview shows one cover for every website template in the catalog.

## chat-composer-slash-panel-006

Original test `Enter keeps the keyboard selection while another workflow is hovered`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L195).

- **Given** The slash panel shows matching workflows and a workflow is highlighted with the keyboard.
- **When** The pointer moves over a different workflow and the user presses Enter.
- **Then** The keyboard-selected workflow, /axiom-status, is inserted instead of the hovered /axiom-red, and the slash panel closes.

## chat-composer-slash-panel-007

Original test `Clicking a workflow activates the pointer target`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L219).

- **Given** The slash panel shows matching workflows and the keyboard has highlighted a workflow.
- **When** The user clicks /axiom-red.
- **Then** The clicked workflow is inserted, the composer receives focus, and the slash panel closes.

## chat-composer-slash-panel-008

Original test `Browse all templates opens the picker and consumes its slash token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L236).

- **Given** The slash panel is open in the composer.
- **When** The user selects Browse all templates.
- **Then** The template picker opens, the slash panel closes, and the slash token is removed from the draft.

## chat-composer-slash-panel-009

Original test `The panel emphasizes the typed query inside a workflow name`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L245).

- **Given** The slash panel shows workflows matching the query “axi.”
- **When** The user views the matching workflow name.
- **Then** The panel emphasizes “axi” within the workflow name.

## chat-composer-slash-panel-010

Original test `Workflow search hides unmatched workflows and restores matching results`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L258).

- **Given** The slash panel shows workflows matching “axi.”
- **When** The user changes the query to “zzz” and then back to “axi.”
- **Then** The unmatched workflow and Workflows heading disappear for “zzz,” while Browse all templates remains available; matching workflows return for “axi.”

## chat-composer-slash-panel-011

Original test `Mobile slash suggestions at /chats/b0000000-0000-4000-a000-000000000900 show capabilities before Workflows and navigate in visual order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L285).

- **Given** The user is composing in mobile layout at /chats/b0000000-0000-4000-a000-000000000900, with slash suggestions open.
- **When** The user navigates through suggestions with the keyboard and activates Presentation templates.
- **Then** Suggestions appear in visual order: Find people, Research, Create, Workflow, three workflows, then Browse all templates. Workflow descriptions are shortened, and keyboard navigation can select the third workflow, the second workflow, and Presentation templates. The composer draft is left without the slash token and the slash panel closes.

## chat-composer-slash-panel-012

Original test `Mobile slash suggestions at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1 show capabilities before Workflows and navigate in visual order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L285).

- **Given** The user is composing in mobile layout at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1, with slash suggestions open.
- **When** The user navigates through suggestions with the keyboard and activates Presentation templates.
- **Then** Suggestions appear in visual order: Find people, Research, Create, Workflow, three workflows, then Browse all templates. Workflow descriptions are shortened, and keyboard navigation can select the third workflow, the second workflow, and Presentation templates. The composer draft is left without the slash token and the slash panel closes.

## chat-composer-slash-panel-013

Original test `Desktop slash suggestions at /chats/b0000000-0000-4000-a000-000000000900 keep capability actions nearest the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L330).

- **Given** The user is composing in desktop layout at /chats/b0000000-0000-4000-a000-000000000900, with slash suggestions open.
- **When** The user navigates upward through the suggestions.
- **Then** Workflows appear before Workflow, Create, Research, and Find people, with Browse all templates last. The panel is above the composer, and upward navigation selects Find people and then Research.

## chat-composer-slash-panel-014

Original test `Desktop slash suggestions at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1 keep capability actions nearest the composer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L330).

- **Given** The user is composing in desktop layout at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1, with slash suggestions open.
- **When** The user navigates upward through the suggestions.
- **Then** Workflows appear before Workflow, Create, Research, and Find people, with Browse all templates last. The panel is above the composer, and upward navigation selects Find people and then Research.

## chat-composer-slash-panel-015

Original test `Keyboard navigation crosses from capability actions into workflows with desktop=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L362).

- **Given** The user is composing in desktop layout in a chat with slash suggestions open.
- **When** The user presses Arrow Up five times and then Tab.
- **Then** Keyboard navigation crosses from capability actions to /axiom-traces; Tab inserts that workflow and closes the slash panel.

## chat-composer-slash-panel-016

Original test `Keyboard navigation crosses from capability actions into workflows with desktop=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L362).

- **Given** The user is composing in mobile layout in a chat with slash suggestions open.
- **When** The user presses Arrow Down five times and then Tab.
- **Then** Keyboard navigation crosses from capability actions to /axiom-red; Tab inserts that workflow and closes the slash panel.

## chat-composer-slash-panel-017

Original test `The workflow overview expands without losing its selectable workflows with desktop=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L414).

- **Given** The desktop composer shows 12 workflows, initially with only eight visible and “Show 8 more” available.
- **When** The user expands the list and selects /daily-12.
- **Then** The list reveals the hidden workflows, keeps the workflows selectable, and displays New workflow after /daily-9 and a Manage workflows link. The composer retains its draft while expanding; selecting /daily-12 inserts it and closes the panel.

## chat-composer-slash-panel-018

Original test `The workflow overview expands without losing its selectable workflows with desktop=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L414).

- **Given** The mobile composer shows 12 workflows, initially with only eight visible and “Show 8 more” available.
- **When** The user expands the list and selects /daily-12.
- **Then** The list reveals the hidden workflows, keeps the workflows selectable, and displays New workflow after /daily-9 and a Manage workflows link. The composer retains its draft while expanding; selecting /daily-12 inserts it and closes the panel.

## chat-composer-slash-panel-019

Original test `Desktop arrow navigation passes Show more without revealing hidden workflows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L443).

- **Given** The desktop slash panel shows 12 workflows with only the first eight visible and “Show 8 more” available.
- **When** The user navigates down and back up across “Show 8 more.”
- **Then** Arrow navigation can select “Show 8 more” and then the Workflow and Create actions without expanding the list or revealing /daily-2.

## chat-composer-slash-panel-020

Original test `Keyboard navigation selects Show more without expanding until activation with desktop=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L459).

- **Given** The desktop composer shows 12 workflows, with hidden workflows behind “Show 8 more.”
- **When** The user navigates to “Show 8 more,” activates it, selects /daily-3, and searches again.
- **Then** Keyboard selection alone does not expand the list; activating “Show 8 more” reveals hidden workflows. The user can select /daily-2 and then /daily-3, and the slash panel closes. A fresh slash query is collapsed again; Escape closes it, and the “daily” query shows matching workflows without Show 8 more or New workflow.

## chat-composer-slash-panel-021

Original test `Keyboard navigation selects Show more without expanding until activation with desktop=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L459).

- **Given** The mobile composer shows 12 workflows, with hidden workflows behind “Show 8 more.”
- **When** The user navigates to “Show 8 more,” activates it, selects /daily-3, and searches again.
- **Then** Keyboard selection alone does not expand the list; activating “Show 8 more” reveals hidden workflows. The user can select /daily-2 and then /daily-3, and the slash panel closes. A fresh slash query is collapsed again; Escape closes it, and the “daily” query shows matching workflows without Show 8 more or New workflow.

## chat-composer-slash-panel-022

Original test `New workflow writes the create-workflow request where the slash was`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L502).

- **Given** The composer shows a workflow list expanded to include New workflow.
- **When** The user selects New workflow.
- **Then** The create-workflow request text is inserted where the slash was, with no slash remaining, and the panel closes.

## chat-composer-slash-panel-023

Original test `Manage workflows opens the Workflows page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L516).

- **Given** The composer shows a workflow list expanded to include Manage workflows.
- **When** The user selects Manage workflows.
- **Then** The browser navigates to /workflows and the slash panel closes.

## chat-composer-slash-panel-024

Original test `The desktop Templates overview at /chats/b0000000-0000-4000-a000-000000000900 keeps covers selectable across pointer handoff`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L532).

- **Given** The desktop Templates overview is open at /chats/b0000000-0000-4000-a000-000000000900, with Website selected.
- **When** The pointer moves from Website to a cover and the user selects the cover.
- **Then** Website remains selected during the pointer handoff. The chosen template is inserted inline in the composer, which retains focus and its draft without the slash token; the slash panel and picker dialog close.

## chat-composer-slash-panel-025

Original test `The desktop Templates overview at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1 keeps covers selectable across pointer handoff`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-slash-panel.test.tsx#L532).

- **Given** The desktop Templates overview is open at /agents/e0000000-0000-4000-a000-000000000010/chat?compose=1, with Website selected.
- **When** The pointer moves from Website to a cover and the user selects the cover.
- **Then** Website remains selected during the pointer handoff. The chosen template is inserted inline in the composer, which retains focus and its draft without the slash token; the slash panel and picker dialog close.
