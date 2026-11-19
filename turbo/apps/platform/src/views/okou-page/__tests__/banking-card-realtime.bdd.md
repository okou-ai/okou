# Banking card realtime

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [banking-card-realtime.test.tsx](banking-card-realtime.test.tsx).

## banking-card-realtime-001

Original test `Duplicate banking cards update together on events and recover after a continuity gap`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/banking-card-realtime.test.tsx#L12).

- **Given** A chat response contains the same banking access link twice, producing two banking action cards that both show Finance Assistant.
- **When** The banking access-changed event fires after the assistant is renamed, then the realtime connection is suspended and restored after a second rename.
- **Then** Both cards update to Updated Finance Assistant after the event, then both update to Recovered Finance Assistant after reconnection.
