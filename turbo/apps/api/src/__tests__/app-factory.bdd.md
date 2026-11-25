# app-factory

## app-factory-001

- Vitest: "createApp > not found > redirects /sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect to the configured app origin"
- Mode: run
- Given: The API at `https://pr-123-api.vm6.ai` has configured App origin `https://pr-123-app.vm6.ai`.
- When: The caller requests `/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect` on the API.
- Then: The response is HTTP 302 with Location `https://pr-123-app.vm6.ai/sign-in?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect`.

## app-factory-002

- Vitest: "createApp > not found > redirects /sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect to the configured app origin"
- Mode: run
- Given: The API at `https://pr-123-api.vm6.ai` has configured App origin `https://pr-123-app.vm6.ai`.
- When: The caller requests `/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect` on the API.
- Then: The response is HTTP 302 with Location `https://pr-123-app.vm6.ai/sign-up/verify?redirect_url=https%3A%2F%2Fwww.okou.ai%2Fconnect`.

## app-factory-003

- Vitest: "createApp > not found > redirects auth requests on https://api.okou.ai to its matching app domain"
- Mode: run
- Given: The API at `https://api.okou.ai` has configured App origin `https://app.okou.ai`.
- When: The caller requests `/sign-in?redirect_url=%2Fchats` on the API.
- Then: The response is HTTP 302 with Location `https://app.okou.ai/sign-in?redirect_url=%2Fchats`.

## app-factory-004

- Vitest: "createApp > not found > redirects auth requests on https://api.okou.ai to its matching app domain"
- Mode: run
- Given: The API at `https://api.okou.ai` has configured App origin `https://app.okou.ai`.
- When: The caller requests `/sign-up/verify?redirect_url=%2Fonboarding` on the API.
- Then: The response is HTTP 302 with Location `https://app.okou.ai/sign-up/verify?redirect_url=%2Fonboarding`.

## app-factory-005

- Vitest: "createApp > not found > returns a 404 JSON response for unmatched routes"
- Mode: run
- Given: The app has no registered legacy fallthrough route.
- When: The caller sends bearer-authenticated `GET /api/legacy/fallthrough?limit=5`.
- Then: The response is HTTP 404 with exactly `{ "error": "Not found" }`.

## app-factory-006

- Vitest: "createApp > not found > keeps registered routes matched normally"
- Mode: run
- Given: The API registers its health route.
- When: The caller sends `GET /health`.
- Then: The response is HTTP 200.

## app-factory-007

- Vitest: "createApp > preview automation bypass > rejects preview requests without the Vercel bypass header or cookie"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The caller sends no credential header or cookie.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required`. It includes the expected credential fingerprint and reports that the cookie header is absent.

## app-factory-008

- Vitest: "createApp > preview automation bypass > exposes preview access rejection to https://pr-20640-app.omby.ai with bypass null"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app.omby.ai` and the caller sends no preview header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required`, echoes the origin and allows credentials.

## app-factory-009

- Vitest: "createApp > preview automation bypass > exposes preview access rejection to https://pr-20640-app.omby.ai with bypass incorrect-preview-secret"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app.omby.ai` and the caller sends an incorrect preview credential header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required`, echoes the origin and allows credentials.

## app-factory-010

- Vitest: "createApp > preview automation bypass > exposes preview access rejection to https://pr-20640-app-okou-app-preview.v… with bypass null"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app-okou-app-preview.vm0.workers.dev` and the caller sends no preview header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required`, echoes the origin and allows credentials.

## app-factory-011

- Vitest: "createApp > preview automation bypass > exposes preview access rejection to https://pr-20640-app-okou-app-preview.v… with bypass incorrect-preview-secret"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app-okou-app-preview.vm0.workers.dev` and the caller sends an incorrect preview credential header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required`, echoes the origin and allows credentials.

## app-factory-012

- Vitest: "createApp > preview automation bypass > denies preview access without allowing a lookalike App origin"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The caller has no preview credential and the origin appends a foreign suffix to the approved Worker hostname.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403 with `Preview automation bypass required` and no allow-origin header.

## app-factory-013

- Vitest: "createApp > preview automation bypass > allows preview requests from https://pr-20640-app.omby.ai with the matching Vercel bypass header"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app.omby.ai` and the caller sends the matching preview header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200, echoes the origin and allows credentials.

## app-factory-014

- Vitest: "createApp > preview automation bypass > allows preview requests from https://pr-20640-app-okou-app-preview.vm0.workers.dev with the matching Vercel bypass header"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. Origin is `https://pr-20640-app-okou-app-preview.vm0.workers.dev` and the caller sends the matching preview header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200, echoes the origin and allows credentials.

## app-factory-015

- Vitest: "createApp > preview automation bypass > allows preview requests with a matching Vercel bypass cookie"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The caller sends the matching preview cookie alongside an unrelated cookie.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-016

- Vitest: "createApp > preview automation bypass > rejects preview requests with the bypass secret in an unrelated cookie"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The secret is present only as the value of an unrelated cookie.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 403.

## app-factory-017

- Vitest: "createApp > preview automation bypass > allows preview requests with the matching Vercel bypass query"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential.
- When: The caller sends `GET /health` with the matching preview credential in the documented query field.
- Then: The response is HTTP 200.

## app-factory-018

- Vitest: "createApp > preview automation bypass > exempts external webhook paths from the guard without the bypass secret"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential.
- When: Without the preview credential, the caller sends GET to an unmatched ordinary route and to the Stripe webhook path, whose webhook method is POST.
- Then: The ordinary request returns HTTP 403. The webhook GET reaches routing and returns HTTP 404 with `Not found`.

## app-factory-019

- Vitest: "createApp > cors > echoes allowed cross-origin on registered route responses"
- Mode: run
- Given: The API runs in production and the browser sends origin `https://app.okou.ai`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin. Access-Control-Allow-Credentials is true.

## app-factory-020

- Vitest: "createApp > cors > echoes exact vm7 app origin with port on registered route responses"
- Mode: run
- Given: The API runs in production and the browser sends origin `https://app.vm7.ai:8443`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin.

## app-factory-021

- Vitest: "createApp > cors > echoes the exact okou.ai production origin"
- Mode: run
- Given: The API runs in production and the browser sends origin `https://okou.ai`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin.

## app-factory-022

- Vitest: "createApp > cors > allows https origins on okou.ai subdomains"
- Mode: run
- Given: The API runs in production and the browser sends origin `https://console.okou.ai`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin.

## app-factory-023

- Vitest: "createApp > cors > does not allow lookalike okou.ai origins"
- Mode: run
- Given: The API runs in production. The browser origin appends a foreign suffix to okou.ai.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and omits the allow-origin header.

## app-factory-024

- Vitest: "createApp > cors > answers preflight without invoking the route handler"
- Mode: run
- Given: A production App browser needs to send a credentialed GET with client identity and request headers.
- When: It sends `OPTIONS /api/chat-threads` with the method and requested headers.
- Then: The preflight returns HTTP 204, echoes the App origin, permits GET, and includes Authorization, X-Vercel-Protection-Bypass, X-Client-Version, X-Client-Type, X-Client-Session-Id and X-Client-Request-Id in allowed headers.

## app-factory-025

- Vitest: "createApp > cors > answers preview preflight from https://pr-20640-app.omby.ai before enforcing the automation bypass"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The browser origin is `https://pr-20640-app.omby.ai`.
- When: The browser sends `OPTIONS /api/chat-threads` for a GET requesting Authorization, X-Vercel-Protection-Bypass and X-Client-Version.
- Then: The preflight returns HTTP 204 without requiring the preview credential, echoes the origin, allows credentials and permits all three requested headers.

## app-factory-026

- Vitest: "createApp > cors > answers preview preflight from https://pr-20640-app-okou-app-preview.vm0.workers.dev before enforcing the automation bypass"
- Mode: run
- Given: The preview API is configured to require the Vercel preview credential. The browser origin is `https://pr-20640-app-okou-app-preview.vm0.workers.dev`.
- When: The browser sends `OPTIONS /api/chat-threads` for a GET requesting Authorization, X-Vercel-Protection-Bypass and X-Client-Version.
- Then: The preflight returns HTTP 204 without requiring the preview credential, echoes the origin, allows credentials and permits all three requested headers.

## app-factory-027

- Vitest: "createApp > cors > allows okou preview app origins"
- Mode: run
- Given: The API runs in preview and the browser origin is `https://pr-22085-app.omby.ai`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin.

## app-factory-028

- Vitest: "createApp > cors > allows standalone okou app Worker origins in preview"
- Mode: run
- Given: The API runs in preview and the browser origin is `https://pr-22085-app-okou-app-preview.vm0.workers.dev`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes that exact origin.

## app-factory-029

- Vitest: "createApp > cors > does not allow app Worker lookalike origins in preview"
- Mode: run
- Given: The API runs in preview and receives two Worker lookalikes: one appends a foreign suffix, and the other uses a different Workers tenant.
- When: The caller requests `GET /health` with those headers.
- Then: Both health requests return HTTP 200 without an allow-origin header.

## app-factory-030

- Vitest: "createApp > cors > does not allow lookalike okou preview origins"
- Mode: run
- Given: The API runs in preview and the browser appends a foreign suffix to a permitted preview App hostname.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 without an allow-origin header.

## app-factory-031

- Vitest: "createApp > cors > rejects disallowed origins by omitting the allow-origin header"
- Mode: run
- Given: The API runs in production and receives an unrelated origin.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 without an allow-origin header.

## app-factory-032

- Vitest: "createApp > cors > allows vm7 origins in development"
- Mode: run
- Given: The API runs in development and receives `https://app.vm7.ai:8443`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes the origin including its port.

## app-factory-033

- Vitest: "createApp > cors > allows vm7 preview origins on any https port"
- Mode: run
- Given: The API runs in preview and receives `https://www.vm7.ai:3042`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200 and echoes the origin including its port.

## app-factory-034

- Vitest: "createApp > web client compatibility > force-upgrades App 0.1098.0 before route matching"
- Mode: run
- Given: The caller identifies as App version `0.1098.0`, below the supported floor.
- When: The caller requests `GET /api/vnc/connections`.
- Then: The compatibility gate returns HTTP 426 before route matching with `Cache-Control: no-store` and exactly `{ "error": "Client update required" }`.

## app-factory-035

- Vitest: "createApp > web client compatibility > force-upgrades App 0.1099.1 before route matching"
- Mode: run
- Given: The caller identifies as App version `0.1099.1`, below the supported floor.
- When: The caller requests `GET /api/vnc/connections`.
- Then: The compatibility gate returns HTTP 426 before route matching with `Cache-Control: no-store` and exactly `{ "error": "Client update required" }`.

## app-factory-036

- Vitest: "createApp > web client compatibility > force-upgrades App 0.1122.1 before route matching"
- Mode: run
- Given: The caller identifies as App version `0.1122.1`, below the supported floor.
- When: The caller requests `GET /api/vnc/connections`.
- Then: The compatibility gate returns HTTP 426 before route matching with `Cache-Control: no-store` and exactly `{ "error": "Client update required" }`.

## app-factory-037

- Vitest: "createApp > web client compatibility > force-upgrades App 0.1150.0 before route matching"
- Mode: run
- Given: The caller identifies as App version `0.1150.0`, below the supported floor.
- When: The caller requests `GET /api/vnc/connections`.
- Then: The compatibility gate returns HTTP 426 before route matching with `Cache-Control: no-store` and exactly `{ "error": "Client update required" }`.

## app-factory-038

- Vitest: "createApp > web client compatibility > force-upgrades prereleases below the supported App release"
- Mode: run
- Given: The App sends release candidate `0.1162.3-rc.1` of the configured minimum release.
- When: The caller requests `GET /health` with those headers.
- Then: The compatibility gate returns HTTP 426.

## app-factory-039

- Vitest: "createApp > web client compatibility > allows the canonical web client floor 0.1162.3"
- Mode: run
- Given: The caller identifies as App version `0.1162.3` and the minimum App version is `0.1162.3`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-040

- Vitest: "createApp > web client compatibility > allows the canonical web client floor 0.1162.3+build.1"
- Mode: run
- Given: The caller identifies as App version `0.1162.3+build.1` and the minimum App version is `0.1162.3`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-041

- Vitest: "createApp > web client compatibility > allows app clients newer than the canonical floor"
- Mode: run
- Given: The caller identifies as App version `0.1162.4` and the minimum App version is `0.1162.3`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-042

- Vitest: "createApp > web client compatibility > does not force upgrade CLI clients"
- Mode: run
- Given: The caller identifies as CLI with version 0.599.18.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-043

- Vitest: "createApp > web client compatibility > does not force upgrade Desktop clients"
- Mode: run
- Given: The caller identifies as Desktop with version 0.599.18.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-044

- Vitest: "createApp > web client compatibility > preserves App requests without a parseable version (undefined)"
- Mode: run
- Given: The caller identifies as App and sends no version header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-045

- Vitest: "createApp > web client compatibility > preserves App requests without a parseable version (development)"
- Mode: run
- Given: The caller identifies as App and sends version `development`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-046

- Vitest: "createApp > web client compatibility > preserves requests without a client type"
- Mode: run
- Given: The caller sends version 0.843.0 without the client-type header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-047

- Vitest: "createApp > iOS client compatibility > force-upgrades iOS builds below the floor before GET /health route matching"
- Mode: run
- Given: An iOS caller identifies as TestFlight version 0.49.0. The shipped TestFlight floor is 0.51.12.
- When: The caller requests `GET /health`.
- Then: Before route matching the API returns HTTP 426 with `Cache-Control: no-store`, code `IOS_UPDATE_REQUIRED`, message `Update Okou in TestFlight to continue.` and minimum supported version 0.51.12.

## app-factory-048

- Vitest: "createApp > iOS client compatibility > force-upgrades iOS builds below the floor before POST /api/chat-threads route matching"
- Mode: run
- Given: An iOS caller identifies as TestFlight version 0.49.0. The shipped TestFlight floor is 0.51.12.
- When: The caller requests `POST /api/chat-threads`.
- Then: Before route matching the API returns HTTP 426 with `Cache-Control: no-store`, code `IOS_UPDATE_REQUIRED`, message `Update Okou in TestFlight to continue.` and minimum supported version 0.51.12.

## app-factory-049

- Vitest: "createApp > iOS client compatibility > allows iOS 0.8.0 at or above the floor"
- Mode: run
- Given: The configured TestFlight floor is 0.8.0 and the iOS caller reports TestFlight version 0.8.0.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-050

- Vitest: "createApp > iOS client compatibility > allows iOS 0.8.1 at or above the floor"
- Mode: run
- Given: The configured TestFlight floor is 0.8.0 and the iOS caller reports TestFlight version 0.8.1.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-051

- Vitest: "createApp > iOS client compatibility > allows iOS 1.0.0 at or above the floor"
- Mode: run
- Given: The configured TestFlight floor is 0.8.0 and the iOS caller reports TestFlight version 1.0.0.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-052

- Vitest: "createApp > iOS client compatibility > allows every iOS version while the floor is null"
- Mode: run
- Given: The TestFlight floor is unset and an iOS TestFlight caller reports version 0.0.1.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-053

- Vitest: "createApp > iOS client compatibility > preserves iOS requests without a parseable version (undefined)"
- Mode: run
- Given: The TestFlight floor is 0.8.0. The iOS caller sends no distribution header and sends no version header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-054

- Vitest: "createApp > iOS client compatibility > preserves iOS requests without a parseable version (development)"
- Mode: run
- Given: The TestFlight floor is 0.8.0. The iOS caller sends no distribution header and sends version `development`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-055

- Vitest: "createApp > iOS client compatibility > preserves iOS requests without a parseable version (0.7)"
- Mode: run
- Given: The TestFlight floor is 0.8.0. The iOS caller sends no distribution header and sends version `0.7`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-056

- Vitest: "createApp > iOS client compatibility > applies the correct floor to app-store 1.1.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.1.0 and distribution `app-store`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-057

- Vitest: "createApp > iOS client compatibility > applies the correct floor to testflight 1.1.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.1.0 and distribution `testflight`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426. The reported minimum is 1.2.0.

## app-factory-058

- Vitest: "createApp > iOS client compatibility > applies the correct floor to app-store 1.0.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.0.0 and distribution `app-store`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-059

- Vitest: "createApp > iOS client compatibility > applies the correct floor to testflight 1.2.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.2.0 and distribution `testflight`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-060

- Vitest: "createApp > iOS client compatibility > applies the correct floor to app-store 0.9.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 0.9.0 and distribution `app-store`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426. The reported minimum is 1.0.0. The error message refers to the App Store.

## app-factory-061

- Vitest: "createApp > iOS client compatibility > applies the correct floor to unknown 0.9.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 0.9.0 and distribution `unknown`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426. The reported minimum is 1.0.0.

## app-factory-062

- Vitest: "createApp > iOS client compatibility > applies the correct floor to future-channel 1.1.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.1.0 and distribution `future-channel`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-063

- Vitest: "createApp > iOS client compatibility > applies the correct floor to undefined 1.1.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 1.1.0 without a distribution header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-064

- Vitest: "createApp > iOS client compatibility > applies the correct floor to undefined 0.9.0"
- Mode: run
- Given: The API has App Store floor 1.0.0 and TestFlight floor 1.2.0. The iOS caller reports version 0.9.0 without a distribution header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426. The reported minimum is 1.0.0.

## app-factory-065

- Vitest: "createApp > iOS client compatibility > preserves bootstrap behavior for undefined 0.49.0"
- Mode: run
- Given: The API has unset App Store floor and TestFlight floor 1.2.0. The iOS caller reports version 0.49.0 without a distribution header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426.

## app-factory-066

- Vitest: "createApp > iOS client compatibility > preserves bootstrap behavior for undefined 0.51.12"
- Mode: run
- Given: The API has unset App Store floor and TestFlight floor 1.2.0. The iOS caller reports version 0.51.12 without a distribution header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-067

- Vitest: "createApp > iOS client compatibility > preserves bootstrap behavior for unknown 0.49.0"
- Mode: run
- Given: The API has unset App Store floor and TestFlight floor 1.2.0. The iOS caller reports version 0.49.0 and distribution `unknown`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-068

- Vitest: "createApp > iOS client compatibility > preserves bootstrap behavior for app-store 0.49.0"
- Mode: run
- Given: The API has unset App Store floor and TestFlight floor 1.2.0. The iOS caller reports version 0.49.0 and distribution `app-store`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-069

- Vitest: "createApp > iOS client compatibility > preserves bootstrap behavior for testflight 0.51.12"
- Mode: run
- Given: The API has unset App Store floor and TestFlight floor 1.2.0. The iOS caller reports version 0.51.12 and distribution `testflight`.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426.

## app-factory-070

- Vitest: "createApp > iOS client compatibility > keeps already excluded headerless installations below the historical floor"
- Mode: run
- Given: An iOS client sends version 0.49.0 without a distribution header. The App Store floor is set to 0.40.0.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 426 and reports minimum supported version 0.51.12.

## app-factory-071

- Vitest: "createApp > iOS client compatibility > gates only the exact iOS client type, not ios"
- Mode: run
- Given: The TestFlight floor is 0.8.0, and the caller’s type is `ios` with version 0.7.4.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-072

- Vitest: "createApp > iOS client compatibility > gates only the exact iOS client type, not IOS"
- Mode: run
- Given: The TestFlight floor is 0.8.0, and the caller’s type is `IOS` with version 0.7.4.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-073

- Vitest: "createApp > iOS client compatibility > does not apply the iOS floor to App clients"
- Mode: run
- Given: The TestFlight floor is 99.0.0. The caller identifies as App with version 0.1162.4.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-074

- Vitest: "createApp > iOS client compatibility > does not apply the iOS floor to Desktop clients"
- Mode: run
- Given: The TestFlight floor is 99.0.0. The caller identifies as Desktop with version 0.1162.4.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.

## app-factory-075

- Vitest: "createApp > iOS client compatibility > preserves requests without a client type"
- Mode: run
- Given: The TestFlight floor is 0.8.0. The caller sends version 0.7.4 without a client-type header.
- When: The caller requests `GET /health` with those headers.
- Then: The response is HTTP 200.
