# Discord installation and account linking

## Scope and rollout boundary

The production OAuth APIs install the actual configured Discord bot in one guild per Okou organization and connect each member's independently verified Discord identity. This is not a preview seed or simulated installation. Discord integration remains **default off**. Publishing this implementation does not register a Discord application, deploy a Gateway, provision production secrets, or authorize activation.

Use `docs/discord-integration.md` for the broader Gateway, native-message, permissions and privacy setup. This guide describes the browser OAuth protocol and its operator prerequisites.

## Discord Developer Portal prerequisites

1. Use one Discord application with its bot. Configure the matching application ID and bot token; do not reuse another application's OAuth client secret.
2. Under **Bot**, enable **Require OAuth2 Code Grant**. Installation verification requires the token response's provider-issued `guild` object. The callback's `guild_id` query parameter is only a consistency hint and cannot prove installation.
3. Under **OAuth2 → Redirects**, register the exact API callback URL:
   `https://<the-approved-api-origin>/api/integrations/discord/oauth/callback`.
   The redirect URI returned by authenticated `start` is also sent unchanged during token exchange. Register production and any explicitly approved preview origins separately; do not rely on wildcard redirects or a different App URL.
4. Install authorization requests use **`bot applications.commands identify guilds`**. Member connections use **`identify guilds`**, without requesting another bot installation.
5. The requested bot privileges are View Channel, Send Messages, Read Message History, Attach Files, Create Public Threads and Send Messages in Threads. **Administrator is not requested.** Channel overwrites and native authorization continue to determine usable permissions; OAuth does not grant global read/send or DM access.
6. Follow the existing integration guide for Gateway intents, interaction verification and bot membership prerequisites. Do not enable Message Content or production Gateway operation merely to test OAuth.

## Deployment configuration

The API requires the existing `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY` and `DISCORD_GATEWAY_SECRET` settings, plus the typed optional **`DISCORD_OAUTH_CLIENT_SECRET`**. Configure `APP_URL` to the fixed authorized App origin. The API selects its callback origin through the existing canonical OAuth-origin resolver.

Missing OAuth configuration returns an actionable 503 from `start`; it does not invent credentials or change the existing native `isAvailable` status meaning. Keep the `DiscordIntegration` feature switch off until separately authorized. Use the normal generated Drizzle migration pipeline, including `1346_discord_oauth_onboarding`; do not hand-edit journal/snapshot metadata or seed business authorization rows.

## Uniform browser protocol

There is one protocol for production and cross-site previews. It does **not** depend on an OAuth correlation cookie, third-party cookies, a current-window fallback, provider-code forwarding, or query-marker authority.

1. **Start in the original authenticated App route.** Open the popup synchronously from the user's gesture. If blocked, show an actionable retry and do not redirect the current window. Authenticated `POST /api/integrations/discord/oauth/start` receives strict `{flow:"install"|"connect", guildId?:string}` and returns `{authorizationUrl, completionToken}`. Capture the issued state from that authorization URL and keep state/completion token only in the original route's memory. Navigate the already-open popup to the returned provider URL.
2. **Provider callback verifies but never binds.** Anonymous `GET /api/integrations/discord/oauth/callback` atomically claims the provider state once. It verifies the token grant, audience, scopes, user identity, guild membership and actual configured bot. Installation additionally requires provider-issued token `guild` evidence, consistency with any selected guild/callback hint and installer guild authority. No connection, installation, welcome or connected realtime event is created here.
3. **Independent consent-browser proof.** Successful verification redirects only to configured App `/works?discord=pending` with:
   `#discord_oauth=approve&state=<issued-state>&approval_proof=<independent-proof>`.
   The provider code, access/refresh tokens and completion token are never forwarded. Redirects use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
4. **Capture and clear the fragment before analytics or other bootstrap telemetry.** Keep its proof in consent-page memory only. Do not put it in query parameters, storage, logs, postMessage or the opener. Use the consent browser's **current** authenticated user and organization for `POST /api/integrations/discord/oauth/approve {state,approvalProof}`. That identity must exactly match the original start owner/org and remain authorized. A victim consenting to an attacker's authorization URL cannot approve an attacker-owned attempt under the victim's own Okou identity. Successful approval returns `{approved:true}` and consumes the independent proof. Approval still does not bind.
5. **Complete only from the original opener.** After the popup closes, authenticated `POST /api/integrations/discord/oauth/complete {state,completionToken}` uses the proof retained in the original route. Only approved, unexpired, same-owner/org attempts are eligible. Current Clerk membership/admin role, feature access, bot/application identity and native guild/sender/bot presence are revalidated before binding. Installation guild authority is checked again against current native guild roles. Success returns `{status:"installed"|"connected"}`; refresh the public status API as the authoritative UI state.
6. **Lost opener memory requires restart.** The consent landing must not auto-complete from its query or fragment. Neither `discord=pending`, `discord=error` nor any invented success marker grants connected state. The CLI opens authenticated `/works` using canonical platform-origin resolution; it does not start an opaque OAuth attempt and transfer it to another browser.

## Proofs, expiry and persistence

State, approval proof and completion token are separate cryptographically random 32-byte values encoded as 43-character base64url strings. Only SHA-256 hashes are persisted. Attempts have the original **10-minute TTL**, which approval and verification do not extend. Callback code is bounded to 2,048 characters and error input to 128; proof/state schemas reject malformed or oversized values. Guild IDs reuse the native unsigned-64-bit snowflake schema, including its overflow check.

The attempt phases are `pending → processing → verified → approved`, or bounded `failed` outcomes. Database checks tie phases to nullable proof hashes and bounded verified guild/user/bot evidence. Credentials, provider codes, raw state and approval/completion secrets are not persisted. A successful installation grant is **not revoked**: provider revocation can remove the installed authorization, rather than merely clean up one transient token.

The approved capability is consumed in the same transaction as final binding. Existing guild/org and guild/user constraints remain; a global identity owner and owner-qualified composite connection FK prevent stealing a Discord identity across guilds. An installation cannot silently move organizations. Repeated legitimate linking leaves one connection and does not resend a welcome.

## Concurrency and cleanup

Claims and every production disconnect, organization uninstall, Gateway guild removal, member/org deletion and account cleanup use stable installation → identity-parent → connection ordering. Identity release checks child absence in a **fresh statement after acquiring the identity parent lock**; a pre-wait antijoin snapshot cannot cascade-delete a newly committed connection. The identity FK uses **RESTRICT**, not CASCADE. Claiming uses an atomic owner-qualified upsert, rather than a racy `INSERT DO NOTHING` followed by a parent read; an occupied identity's owner is never changed.

Welcome delivery is attempted once for a newly inserted committed connection, after independent authorization of its exact DM recipient. Failed welcome authorization does not undo the connection. Realtime invalidation occurs only after committed final binding or cleanup. User/org cleanup also removes outstanding owned attempts; disconnect/uninstall cancels the affected workspace's outstanding attempts. Expired attempts are removed by the existing OAuth cleanup path and bounded opportunistic start cleanup.

## Telemetry privacy boundary

`@hono/otel` normally captures `url.full` before the handler. The Discord callback is therefore excluded **before span creation**, without altering its real query or disabling other route tracing. Existing path/status request logging remains. Response headers are not captured, so the approval-fragment `Location` cannot become a span attribute.

Production Sentry disables incoming-body capture for all four Discord OAuth routes, filters their request events before transport and drops OAuth/proof-bearing HTTP URL breadcrumbs. Safe handler errors or redirect headers alone are not a substitute for these upstream controls. App-side fragment removal must happen before analytics initialization. Do not print proofs or full callback/landing URLs in helper exceptions or diagnostics.

## Verification and acceptance

Use the real default PostgreSQL route-test harness, not `isolatePg: true`, for concurrency evidence. The new security suite exercises actual issued public credentials through start → provider callback → authenticated approval → opener completion → public status, mocking only external Discord/Clerk behavior. Provider-controlled gates coordinate real concurrent public connect/disconnect requests; no private SQL barrier or business-state seed is used.

Focused commands:

```sh
TZ=UTC pnpm -F api exec vitest run src/signals/routes/__tests__/discord-oauth.test.ts src/lib/__tests__/discord-oauth-telemetry.test.ts
pnpm -F api check-types:core
```

The route suite includes a real OpenTelemetry exporter test proving the provider query is still handled while raw state/code/completion/approval values and full approval Location are absent from exported attributes/events. The Sentry test uses the actual SDK and transport boundary, preserving unrelated events while filtering sensitive OAuth request/breadcrumb data. Parent integration also owns the unchanged shared public helper and ten legacy parity executions.

Live Discord consent, bot installation, native send/read/DM acceptance and Gateway enablement require a separately authorized test guild and registered redirect/configuration. Local scoped tests are not evidence that production Discord has been activated.
