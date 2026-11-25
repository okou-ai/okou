# vnc-rsa-aes

## vnc-rsa-aes-001

- Vitest: "RSA-AES owner and private Runner boundaries > preserves both exact credential subtypes and pin for rsa_aes_ra2"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner and a chat-enabled VNC host. Parameter row `rsa_aes_ra2`: the host is rebound directly to `rsa.example.com`.
- When: For each of `rsa_aes_password` and `rsa_aes_username_password` (username `用户名`, an 85-character `界` password), the member rebinds the host via `PATCH /api/vnc/connections/:connectionId` with security `rsa_aes_ra2`, an upper-case server key pin and a new inline credential; the Runner then calls `POST /api/runners/runs/:runId/vnc/resolve` declaring exactly that method, `rsa_aes_ra2` and the `direct` transport.
- Then: Each rebind returns HTTP 200 with security `rsa_aes_ra2` and the lower-case pin, `rsaAesAuthentication` set to the method, and no password in the body. Each resolve returns `resolved_rsa_aes` at the saved generation with the same security and the exact authentication (method, username where applicable, and password), and without a `serverName`.

## vnc-rsa-aes-002

- Vitest: "RSA-AES owner and private Runner boundaries > preserves both exact credential subtypes and pin for rsa_aes_ra2_256"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner and a chat-enabled VNC host. Parameter row `rsa_aes_ra2_256`: the host is rebound directly to `rsa.example.com`.
- When: For each of `rsa_aes_password` and `rsa_aes_username_password` (username `用户名`, an 85-character `界` password), the member rebinds the host via `PATCH /api/vnc/connections/:connectionId` with security `rsa_aes_ra2_256`, an upper-case server key pin and a new inline credential; the Runner then calls `POST /api/runners/runs/:runId/vnc/resolve` declaring exactly that method, `rsa_aes_ra2_256` and the `direct` transport.
- Then: Each rebind returns HTTP 200 with security `rsa_aes_ra2_256` and the lower-case pin, `rsaAesAuthentication` set to the method, and no password in the body. Each resolve returns `resolved_rsa_aes` at the saved generation with the same security and the exact authentication (method, username where applicable, and password), and without a `serverName`.

## vnc-rsa-aes-003

- Vitest: "RSA-AES owner and private Runner boundaries > preserves both exact credential subtypes and pin for rsa_aes_ra2ne"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner and a chat-enabled VNC host. Parameter row `rsa_aes_ra2ne`: the member creates an SSH connection and enables its chat default, and the host is rebound to `127.0.0.1` through it.
- When: For each of `rsa_aes_password` and `rsa_aes_username_password` (username `用户名`, an 85-character `界` password), the member rebinds the host via `PATCH /api/vnc/connections/:connectionId` with security `rsa_aes_ra2ne`, an upper-case server key pin and a new inline credential; the Runner then calls `POST /api/runners/runs/:runId/vnc/resolve` declaring exactly that method, `rsa_aes_ra2ne` and the `ssh` transport.
- Then: Each rebind returns HTTP 200 with security `rsa_aes_ra2ne` and the lower-case pin, `rsaAesAuthentication` set to the method, and no password in the body. Each resolve returns `resolved_rsa_aes` at the saved generation with the same security and the exact authentication (method, username where applicable, and password), and without a `serverName`.

## vnc-rsa-aes-004

- Vitest: "RSA-AES owner and private Runner boundaries > preserves both exact credential subtypes and pin for rsa_aes_ra2ne_256"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner and a chat-enabled VNC host. Parameter row `rsa_aes_ra2ne_256`: the member creates an SSH connection and enables its chat default, and the host is rebound to `127.0.0.1` through it.
- When: For each of `rsa_aes_password` and `rsa_aes_username_password` (username `用户名`, an 85-character `界` password), the member rebinds the host via `PATCH /api/vnc/connections/:connectionId` with security `rsa_aes_ra2ne_256`, an upper-case server key pin and a new inline credential; the Runner then calls `POST /api/runners/runs/:runId/vnc/resolve` declaring exactly that method, `rsa_aes_ra2ne_256` and the `ssh` transport.
- Then: Each rebind returns HTTP 200 with security `rsa_aes_ra2ne_256` and the lower-case pin, `rsaAesAuthentication` set to the method, and no password in the body. Each resolve returns `resolved_rsa_aes` at the saved generation with the same security and the exact authentication (method, username where applicable, and password), and without a `serverName`.

## vnc-rsa-aes-005

- Vitest: "RSA-AES owner and private Runner boundaries > denies wrong capabilities before KMS and invalidates pin/password generations and revoked authority"
- Mode: run
- Given: A Pro member has a running chat Run and a chat-enabled VNC host rebound to `rsa_aes_ra2` with a server key pin and an `rsa_aes_password` credential (generation 2).
- When: The Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with no supported profiles and with only an `rsa_aes_ra2_256` profile; the member changes the pin at generation 2, sends a stale pin change at generation 2, and rotates the password to `rotated` via `PATCH /api/vnc/credentials/:credentialId`; the Runner resolves with the `rsa_aes_password`/`rsa_aes_ra2`/direct profile; the member disables the host's VNC chat default and the Runner resolves again.
- Then: Both mismatched resolves return `{ outcome: "unsupported_profile" }` without decryption. The pin change returns HTTP 200, the stale change HTTP 409, and the rotation HTTP 200. The matching resolve returns `resolved_rsa_aes` at generation 4 with the new pin and password `rotated`. After the chat default is disabled, resolve returns `{ outcome: "unavailable" }` without decryption.

## vnc-rsa-aes-006

- Vitest: "RSA-AES owner and private Runner boundaries > rejects bytes, NUL, malformed Unicode, CA alias and direct-ne without encrypting"
- Mode: run
- Given: A signed-in workspace member.
- When: The member posts `rsa_aes_password` credentials via `POST /api/vnc/credentials` with a 128-character `é` password, a password containing NUL, and a lone surrogate; then posts hosts via `POST /api/vnc/connections` with a direct `rsa_aes_ra2ne` route, a 20-byte pin, and an `rsa_aes_ra2` profile carrying a `trust` field.
- Then: Every request returns HTTP 400 and no data key is generated.

## vnc-rsa-aes-007

- Vitest: "RSA-AES owner and private Runner boundaries > preserves the independently computed fixed-width pin for 3072-bit public keys"
- Mode: run
- Given: A signed-in workspace member and a 3072-bit RSA public key with exponent 65537. Parameter row `3072`.
- When: The member submits the key in SPKI and in PKCS#1 PEM form to `POST /api/vnc/rsa-key-pin`.
- Then: Both responses are HTTP 200 with `cache-control: no-store` and exactly `{ serverKeySha256, modulusBits: 3072 }`, where the hash is SHA-256 of the 4-byte bit length, the modulus and the exponent padded to the modulus width.

## vnc-rsa-aes-008

- Vitest: "RSA-AES owner and private Runner boundaries > preserves the independently computed fixed-width pin for 4096-bit public keys"
- Mode: run
- Given: A signed-in workspace member and a 4096-bit RSA public key with exponent 65537. Parameter row `4096`.
- When: The member submits the key in SPKI and in PKCS#1 PEM form to `POST /api/vnc/rsa-key-pin`.
- Then: Both responses are HTTP 200 with `cache-control: no-store` and exactly `{ serverKeySha256, modulusBits: 4096 }`, where the hash is SHA-256 of the 4-byte bit length, the modulus and the exponent padded to the modulus width.

## vnc-rsa-aes-009

- Vitest: "RSA-AES owner and private Runner boundaries > rejects unsupported RSA sizes and exponents and non-RSA public keys without parser diagnostics"
- Mode: run
- Given: A signed-in workspace member and four public keys: a 1024-bit RSA key, a 2048-bit RSA key with exponent 3, an EC P-256 key and an RSA-PSS key.
- When: The member submits each key in SPKI PEM form to `POST /api/vnc/rsa-key-pin`.
- Then: Every request returns HTTP 400 with error code `VNC_INVALID_INPUT`.

## vnc-rsa-aes-010

- Vitest: "RSA-AES owner and private Runner boundaries > converts public PEM to a fixed-width wire hash and rejects private or extra material"
- Mode: run
- Given: A signed-in workspace member and a 2048-bit RSA key pair with exponent 65537.
- When: The member submits the public key in SPKI and PKCS#1 PEM to `POST /api/vnc/rsa-key-pin`; then submits the private key, two concatenated public keys, a certificate block containing `private-canary`, and 16,385 characters; and finally submits the public key without authentication.
- Then: Both public-key submissions return HTTP 200 with `cache-control: no-store` and `{ serverKeySha256, modulusBits: 2048 }` matching the fixed-width wire hash. Every invalid submission returns HTTP 400 without echoing `private-canary`, and nothing is decrypted. The unauthenticated request returns HTTP 401.
