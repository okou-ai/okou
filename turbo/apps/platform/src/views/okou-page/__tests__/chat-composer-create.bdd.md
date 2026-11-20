# Chat composer create

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-create.test.tsx](chat-composer-create.test.tsx).

## chat-composer-create-001

Original test `Persisted additional info stays out of the message and copied text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L115).

- **Given** A chat contains a user message with additional generation settings and the text “Our launch brief.”
- **When** The user views and copies the message.
- **Then** The message shows “Our launch brief” without the Create instruction or settings, and the copied plain text is exactly “Our launch brief”.

## chat-composer-create-002

Original test `A queued Create message keeps its intent separate from user-authored text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L190).

- **Given** A chat has an active run and the user opens the composer.
- **When** They enter Presentation mode, type “Create a presentation. Keep these words in my message.”, choose 20–24 slides, and send.
- **Then** The queued message keeps the full typed text as user-authored text and stores the Create intent and “Slide count: 20-24” separately as additional information.

## chat-composer-create-003

Original test `Image adds a template without replacing the existing text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L262).

- **Given** The composer contains “Our launch” and the user enters Image creation mode.
- **When** They select the first image template from the catalog.
- **Then** The catalog closes, one inline chip shows the selected template, “Our launch” remains, the Image mode chip remains, and the Claude Fable 5.1 model control is visible.

## chat-composer-create-004

Original test `Presentation adds a template without replacing the existing text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L262).

- **Given** The composer contains “Our launch” and the user enters Presentation creation mode.
- **When** They select the first presentation template from the catalog.
- **Then** The catalog closes, one inline chip shows the selected template, “Our launch” remains, the Presentation mode chip remains, and the Claude Fable 5.1 model control is visible.

## chat-composer-create-005

Original test `Create image sends every edited draft template reference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L353).

- **Given** A saved Image draft contains two template references separated by “Our launch” and “for the cover.”
- **When** The user replaces the first template with another image template and sends in Image creation mode.
- **Then** The submitted message includes the Image creation intent, both edited template references in order (the replacement followed by the second original), and both text fragments.

## chat-composer-create-006

Original test `Entering Presentation preserves an existing draft template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L407).

- **Given** A saved draft contains one presentation template.
- **When** The user enters Presentation mode.
- **Then** The existing template remains as the single inline chip, and the Presentation mode chip appears.

## chat-composer-create-007

Original test `Presentation adds another template when the draft already has one`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L415).

- **Given** A saved Presentation draft contains one template.
- **When** The user enters Presentation mode and adds a second template.
- **Then** Two inline chips remain in order: the original template followed by the newly selected template.

## chat-composer-create-008

Original test `Image mode opens its style picker from the Add menu`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L430).

- **Given** The user is in Image creation mode.
- **When** They choose Add style from the Add menu.
- **Then** The style picker opens with the Image tab selected.

## chat-composer-create-009

Original test `Exiting Create mode sends the ordinary draft and template`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L487).

- **Given** A draft contains “Our launch /notes” and a presentation template, and the user is in Presentation creation mode.
- **When** They exit Create mode and send the draft.
- **Then** The ordinary draft text and template are submitted, with no additional-information part; the editor retains the text and template after exiting Create mode.

## chat-composer-create-010

Original test `An inline template chip shows the chosen cover`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L539).

- **Given** The user selects a presentation template with a cover.
- **When** They view its inline chip in the composer.
- **Then** The chip shows the template title and an image whose source contains the template’s slug.

## chat-composer-create-011

Original test `A template with no cover keeps the template glyph on its chip`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-create.test.tsx#L547).

- **Given** The user selects a website template with no cover.
- **When** They view its inline chip in the composer.
- **Then** The chip has no cover image.
