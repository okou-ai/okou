# wechat-client

## wechat-client-001

- Vitest: "WeChat protocol boundaries > preserves uint64 IDs and does not rewrite message text"
- Mode: run
- Intent: review
- Given: The WeChat receiver has a session token and no saved cursor. The provider supplies a message with numeric ID 18446744073709551615 and text `message_id: 123`.
- When: The receiver polls `POST /ilink/bot/getupdates`.
- Then: The receiver sees the whole ID as the string `18446744073709551615` and the original text unchanged.

## wechat-client-002

- Vitest: "WeChat protocol boundaries > recognizes a provider business failure even with HTTP 200"
- Mode: run
- Intent: review
- Given: A linked WeChat session has a recipient and conversation context. WeChat returns HTTP 200 with `ret: -1` and a private message.
- When: The client sends text through `POST /ilink/bot/sendmessage`.
- Then: The operation rejects with a message containing `WeChat rejected the request`.

## wechat-client-003

- Vitest: "WeChat protocol boundaries > marks expired sessions distinctly"
- Mode: run
- Intent: review
- Given: The receiver uses a session token and WeChat reports `ret: -14`.
- When: The receiver polls `POST /ilink/bot/getupdates`.
- Then: The receive operation reports a distinct session-expired error.

## wechat-client-004

- Vitest: "WeChat protocol boundaries > keeps a transport failure visible to the receiver"
- Mode: run
- Intent: review
- Given: The receiver has a session token and a saved cursor. The provider request fails at the transport boundary.
- When: The receiver polls `POST /ilink/bot/getupdates`.
- Then: The receive operation rejects with a message containing `Failed to fetch`.

## wechat-client-005

- Vitest: "WeChat protocol boundaries > keeps a upstream timeout response visible to the receiver"
- Mode: run
- Intent: review
- Given: The receiver has a session token and a saved cursor. WeChat responds with HTTP 504.
- When: The receiver polls `POST /ilink/bot/getupdates`.
- Then: The receive operation rejects with a message containing `WeChat request failed (504)`.

## wechat-client-006

- Vitest: "WeChat protocol boundaries > keeps a provider rejection visible to the receiver"
- Mode: run
- Intent: review
- Given: The receiver has a session token and a saved cursor. WeChat returns `ret: -1`.
- When: The receiver polls `POST /ilink/bot/getupdates`.
- Then: The receive operation rejects with a message containing `WeChat rejected the request`.

## wechat-client-007

- Vitest: "WeChat protocol boundaries > propagates a caller-owned AbortError instead of reporting an idle receive"
- Mode: run
- Intent: review
- Given: The receiver has a session token and saved cursor, and its poll is already in flight.
- When: The caller aborts the receive with a reason of type `AbortError`.
- Then: The receive operation yields the exact caller-provided reason as its failure.

## wechat-client-008

- Vitest: "WeChat protocol boundaries > propagates a caller-owned TimeoutError instead of reporting an idle receive"
- Mode: run
- Intent: review
- Given: The receiver has a session token and saved cursor, and its poll is already in flight.
- When: The caller aborts the receive with a reason of type `TimeoutError`.
- Then: The receive operation yields the exact caller-provided reason as its failure.

## wechat-client-009

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: http://ilinkai.weixin.qq.com"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `http://ilinkai.weixin.qq.com`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.

## wechat-client-010

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: https://ilinkai.weixin.qq.com.evil.test"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `https://ilinkai.weixin.qq.com.evil.test`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.

## wechat-client-011

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: https://evil.test"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `https://evil.test`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.

## wechat-client-012

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: https://user:secret@ilinkai.weixin.qq.com"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `https://user:secret@ilinkai.weixin.qq.com`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.

## wechat-client-013

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: https://ilinkai.weixin.qq.com:444"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `https://ilinkai.weixin.qq.com:444`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.

## wechat-client-014

- Vitest: "WeChat protocol boundaries > rejects a credential destination outside the trusted origin: https://ilinkai.weixin.qq.com/path"
- Mode: run
- Intent: review
- Given: The configured WeChat destination is `https://ilinkai.weixin.qq.com/path`.
- When: The client validates the credential destination.
- Then: Validation throws `Invalid WeChat service origin`.
