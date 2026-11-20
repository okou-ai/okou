# Chat localization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-localization.test.tsx](chat-localization.test.tsx).

## chat-localization-001

Original test `Changing language preserves the conversation while Settings stays open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-localization.test.tsx#L236).

- **Given** A user is viewing an existing conversation titled “Planejamento semanal” with Settings open in Portuguese (Brazil).
- **When** They change the language to English.
- **Then** The document language changes to English, while the Settings dialog remains open and the conversation title and URL stay unchanged.

## chat-localization-002

Original test `Closing translated Settings preserves the conversation and unsent draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-localization.test.tsx#L248).

- **Given** A user is viewing an existing conversation titled “Planejamento semanal” with Settings open in Portuguese (Brazil) and an unsent draft, “Rascunho ainda não enviado.”
- **When** They change the language to English and close Settings.
- **Then** The Settings dialog closes, the conversation title and path remain unchanged, and the unsent draft remains in the composer.
