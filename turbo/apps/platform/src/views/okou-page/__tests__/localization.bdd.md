# Localization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [localization.test.tsx](localization.test.tsx).

## localization-001

Original test `French uses local number formatting`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/localization.test.tsx#L84).

- **Given** A completed run displays a duration of 1.2 seconds, and the user has opened Settings.
- **When** The user selects Français as the language and closes Settings.
- **Then** The document language becomes fr-FR and the run duration is formatted as “1,2s”.
