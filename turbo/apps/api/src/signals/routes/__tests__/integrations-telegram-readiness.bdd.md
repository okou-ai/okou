# integrations-telegram-readiness

## integrations-telegram-readiness-001

- Vitest: "Telegram connection readiness diagnostics > reports a 200 probe with length 5000 without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and token for bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 200 and `content-length: 5000`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe sent to Telegram carries `origin=https://app.example.com` and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false` and installation `{id: official, botUsername: test_okou_bot, loginBotId: "9876543210", domainConfigured: true}`, without a readiness error.

## integrations-telegram-readiness-002

- Vitest: "Telegram connection readiness diagnostics > reports a 200 probe with length 38 without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 200 and `content-length: 38`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe carries the app origin and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false`, `readinessError: domain_not_verified` and the installation with `loginBotId: "9876543210"` and `domainConfigured: false`.

## integrations-telegram-readiness-003

- Vitest: "Telegram connection readiness diagnostics > reports a 200 probe with length 1000 without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 200 and `content-length: 1000`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe carries the app origin and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false`, `readinessError: domain_not_verified` and the installation with `domainConfigured: false`.

## integrations-telegram-readiness-004

- Vitest: "Telegram connection readiness diagnostics > reports a 200 probe with length null without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 200 and no `content-length` header.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe carries the app origin and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false`, `readinessError: domain_not_verified` and the installation with `domainConfigured: false`.

## integrations-telegram-readiness-005

- Vitest: "Telegram connection readiness diagnostics > reports a 503 probe with length 38 without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 503 and `content-length: 38`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe carries the app origin and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false`, `readinessError: domain_check_failed` and the installation with `domainConfigured: false`.

## integrations-telegram-readiness-006

- Vitest: "Telegram connection readiness diagnostics > reports a 503 probe with length 5000 without guessing domain configuration"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot is configured with username `test_okou_bot` and bot ID 9876543210, and the app origin is `https://app.example.com`. Telegram's OAuth page answers the domain probe with HTTP 503 and `content-length: 5000`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com&source=onboarding` with a client request ID.
- Then: The probe carries the app origin and `bot_id=9876543210`. The response is HTTP 200 with exactly `linked: false`, `readinessError: domain_check_failed` and the installation with `domainConfigured: false`.

## integrations-telegram-readiness-007

- Vitest: "Telegram connection readiness diagnostics > explains missing bot username separately from a domain check failure"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot token and webhook secret are configured but the bot username is not.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com` without a source.
- Then: The response is HTTP 200 with `linked: false` and `readinessError: bot_not_configured`.

## integrations-telegram-readiness-008

- Vitest: "Telegram connection readiness diagnostics > explains missing bot token separately from a domain check failure"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot username and webhook secret are configured but the bot token is not.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com` without a source.
- Then: The response is HTTP 200 with `linked: false` and `readinessError: bot_not_configured`.

## integrations-telegram-readiness-009

- Vitest: "Telegram connection readiness diagnostics > explains invalid bot id separately from a domain check failure"
- Mode: run
- Given: A signed-in member has not linked Telegram. The official bot token is `invalid:test-bot-secret`, whose bot ID is not numeric.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=https://app.example.com` without a source.
- Then: The response is HTTP 200 with `linked: false` and `readinessError: bot_not_configured`.

## integrations-telegram-readiness-010

- Vitest: "Telegram connection readiness diagnostics > reports transport failure and allows a later Works attempt to verify the domain"
- Mode: run
- Given: A signed-in member has not linked Telegram and the official bot is configured. Telegram's OAuth domain probe first fails at the network level, then later answers with `content-length: 5000`.
- When: The member calls `GET /api/integrations/telegram/link?botId=official&origin=…&source=onboarding`, then calls it again with `source=works`.
- Then: The first response is HTTP 200 with `linked: false`, `readinessError: domain_check_failed` and `domainConfigured: false`. The retried response has `linked: false`, `domainConfigured: true` and no `readinessError`.
