# Safe area

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [safe-area.test.ts](safe-area.test.ts).

## safe-area-001

Original test `safe-area properties > starts the avoidable bottom inset at the physical one`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/css/__tests__/safe-area.test.ts#L54). · **intent review**

- **Given** The app’s entrypoint stylesheet defines its safe-area properties.
- **When** The default root safe-area rule is checked.
- **Then** The avoidable bottom inset is set to the physical bottom inset.

## safe-area-002

Original test `safe-area properties > retires the avoidable bottom inset while the keyboard is open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/css/__tests__/safe-area.test.ts#L62). · **intent review**

- **Given** The app’s entrypoint stylesheet defines a root rule for when the keyboard is open.
- **When** That rule is checked.
- **Then** The avoidable bottom inset is set to 0px while the keyboard is open, including for surfaces using a body-level portal.
