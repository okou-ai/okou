# Cloudflare access chat refresh

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [cloudflare-access-chat-refresh.test.tsx](cloudflare-access-chat-refresh.test.tsx).

## cloudflare-access-chat-refresh-001

Original test `Reopening the composer refreshes a renamed SSH host while preserving default access`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/cloudflare-access-chat-refresh.test.tsx#L18).

- **Given** A chat has two SSH hosts: Private server is enabled by default and Direct server is disabled by default. The composer shows remote access with one enabled host.
- **When** The user opens Remote access, closes it, the private host is renamed, and a Cloudflare Access change is announced before the user reopens the composer settings.
- **Then** The reopened settings show SSH Renamed private server as Default (On) and SSH Direct server as Default (Off). The old Private server name is absent.
