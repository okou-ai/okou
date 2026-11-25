# wechat-media

## wechat-media-001

- Vitest: "WeChat media wire boundary > decrypts the provider's raw key encoding without exposing credentials to the CDN"
- Mode: run
- Intent: review
- Given: The provider supplies an encrypted file, its plaintext length, a download query token and a base64-encoded raw 16-byte AES key.
- When: The client requests the media bytes from the WeChat CDN and decrypts them.
- Then: The CDN request includes the encrypted query parameter and no Authorization header. The plaintext matches the original CSV bytes exactly.

## wechat-media-002

- Vitest: "WeChat media wire boundary > decrypts the provider's hex key encoding without exposing credentials to the CDN"
- Mode: run
- Intent: review
- Given: The provider supplies an encrypted file, its plaintext length, a download query token and a base64-encoded hexadecimal-text AES key.
- When: The client requests the media bytes from the WeChat CDN and decrypts them.
- Then: The CDN request includes the encrypted query parameter and no Authorization header. The plaintext matches the original CSV bytes exactly.

## wechat-media-003

- Vitest: "WeChat media wire boundary > rejects an untrusted media target http://novac2c.cdn.weixin.qq.com/c2c/download"
- Mode: run
- Intent: review
- Given: The provider media descriptor includes a key and sets its download URL to `http://novac2c.cdn.weixin.qq.com/c2c/download`.
- When: The client attempts to download the media.
- Then: The operation rejects with a message containing `invalid media origin`.

## wechat-media-004

- Vitest: "WeChat media wire boundary > rejects an untrusted media target https://attacker.example/c2c/download"
- Mode: run
- Intent: review
- Given: The provider media descriptor includes a key and sets its download URL to `https://attacker.example/c2c/download`.
- When: The client attempts to download the media.
- Then: The operation rejects with a message containing `invalid media origin`.

## wechat-media-005

- Vitest: "WeChat media wire boundary > rejects an untrusted media target https://user:pass@novac2c.cdn.weixin.qq.com/c2c/download"
- Mode: run
- Intent: review
- Given: The provider media descriptor includes a key and sets its download URL to `https://user:pass@novac2c.cdn.weixin.qq.com/c2c/download`.
- When: The client attempts to download the media.
- Then: The operation rejects with a message containing `invalid media origin`.

## wechat-media-006

- Vitest: "WeChat media wire boundary > rejects an untrusted media target https://novac2c.cdn.weixin.qq.com/private"
- Mode: run
- Intent: review
- Given: The provider media descriptor includes a key and sets its download URL to `https://novac2c.cdn.weixin.qq.com/private`.
- When: The client attempts to download the media.
- Then: The operation rejects with a message containing `invalid media origin`.

## wechat-media-007

- Vitest: "WeChat media wire boundary > reads the upstream plain-image variant without inventing a key"
- Mode: run
- Intent: review
- Given: The upstream image descriptor provides a download query parameter and no AES key. The CDN returns unencrypted bytes.
- When: The client downloads the image.
- Then: The returned bytes match the CDN body exactly.

## wechat-media-008

- Vitest: "WeChat media wire boundary > rejects size mismatches after decryption"
- Mode: run
- Intent: review
- Given: The upstream file descriptor claims a 100-byte plaintext, but the correctly decrypted payload is shorter.
- When: The client downloads and validates the media.
- Then: The operation rejects with a message containing `size does not match`.

## wechat-media-009

- Vitest: "WeChat media wire boundary > bounds encrypted download bytes"
- Mode: run
- Intent: review
- Given: The CDN sends a body of 10 MiB plus 32 bytes for a file declared encrypted.
- When: The client downloads media with a valid key descriptor.
- Then: The operation rejects with a message containing `exceeds 10 MiB`.

## wechat-media-010

- Vitest: "WeChat media wire boundary > uploads and sends text/csv with exact provider message IDs"
- Mode: run
- Intent: review
- Given: A linked WeChat sender has a provider token, conversation context and attachment bytes labeled `text/csv`.
- When: The client requests a provider upload URL, uploads the encrypted bytes to the CDN and sends the resulting media item to WeChat.
- Then: The upload request reports the original size, a 16-byte encrypted size and media type `3`. The CDN receives no Authorization header and the encrypted body decrypts to the original bytes. The send request uses the provider token and conversation context with item type `4`. The caller receives the full provider ID as `18446744073709551615`.

## wechat-media-011

- Vitest: "WeChat media wire boundary > uploads and sends image/png with exact provider message IDs"
- Mode: run
- Intent: review
- Given: A linked WeChat sender has a provider token, conversation context and attachment bytes labeled `image/png`.
- When: The client requests a provider upload URL, uploads the encrypted bytes to the CDN and sends the resulting media item to WeChat.
- Then: The upload request reports the original size, a 16-byte encrypted size and media type `1`. The CDN receives no Authorization header and the encrypted body decrypts to the original bytes. The send request uses the provider token and conversation context with item type `2`. The caller receives the full provider ID as `18446744073709551615`.

## wechat-media-012

- Vitest: "WeChat media wire boundary > uploads and sends video/mp4 with exact provider message IDs"
- Mode: run
- Intent: review
- Given: A linked WeChat sender has a provider token, conversation context and attachment bytes labeled `video/mp4`.
- When: The client requests a provider upload URL, uploads the encrypted bytes to the CDN and sends the resulting media item to WeChat.
- Then: The upload request reports the original size, a 16-byte encrypted size and media type `2`. The CDN receives no Authorization header and the encrypted body decrypts to the original bytes. The send request uses the provider token and conversation context with item type `5`. The caller receives the full provider ID as `18446744073709551615`.
