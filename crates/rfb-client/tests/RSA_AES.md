# RSA-AES engine interoperability (opt-in)

This is **engine-only** evidence for #37499 under #35045. It does not expose a saved Owner/API/Runner profile, enable VncAccess, or prove an Owner→Agent→Runner PNG. No RealVNC SystemAuth/SSO/MFA, RA2r or unspecified server compatibility is claimed.

## Exact policy and wire

`authenticate_rsa_aes` selects exactly RA2 (5), RA2_256 (129), RA2ne (6) or RA2ne_256 (130) on RFB 3.8. Its credential constructor fixes subtype 1 (username/password) or 2 (password only), 1–255 exact UTF-8 bytes per field without NUL, preserving spaces. There is no classic-password truncation or alternate-subtype fallback.

The required `RsaServerKeyPin` is **32 SHA256 bytes over U32 big-endian RSA bit length || fixed-width big-endian modulus || equally fixed-width exponent**, with widths `bits / 8`. Acquire it independently from the owner/server key file, never from an untrusted first connection. It is not SPKI/PEM text hashing, a CA policy, or TigerVNC's short SHA1 display fingerprint. The engine verifies it before client exchange/credentials, accepts server RSA 2048/3072/4096 bits with exponent 65537 and valid modulus shape, and generates a fresh fixed 2048-bit client. Other legal protocol parameters are explicitly unsupported. The independent fixture below exercises 2048-bit server keys; wider accepted sizes are not relabelled as independent interop.

RSA PKCS#1 v1.5 random exchange and SHA1-128/SHA256-256 derivation/proof follow the pinned protocol. Private client decrypt uses blinding. At most two blocking crypto jobs hold their permits until completion, including after cancellation; they own no stream. The <=30s absolute deadline bounds the asynchronous handshake and drops the stream on failure/cancel; already-running fixed-size CPU work may finish separately.

The owned record layer authenticates U16 big-endian length as AAD, uses a 16-byte EAX tag and independent little-endian 128-bit counters from zero, refuses 2^32 records/nonce reuse, bounds payload at 65535 bytes and one read/pending-write frame, and releases plaintext only after constant-time MAC verification. Empty-frame/per-poll work is bounded. Record/RFB boundaries need not align. Accepted buffered writes are drained by flush/next write; uncertain IO closes rather than replays.

Full variants retain EAX through SecurityResult and the whole session. `ne` explicitly flushes encrypted credentials, refuses unread encrypted plaintext and switches to raw before SecurityResult. **It does not protect the desktop stream**; any future product admission requires separately verified outer protection. Concrete stream selection never falls back. Okou-owned credentials, directional keys and plaintext buffers zeroize; RustCrypto EAX's internal temporary key copies have no immediate-erasure guarantee. No secret-bearing cause/Debug output is exposed.

## Independent installed-release fixture

Ubuntu 24.04, exact installed packages:

- TigerVNC `1.13.1+dfsg-2build2` (underlying X server 1.21.1.11)
- Nettle `3.9.1-2.2build1.1`
- PAM `1.5.3-5ubuntu5.7`

Requires `Xtigervnc`, `tigervncpasswd`, OpenSSL, Python 3, existing `/etc/pam.d/tigervnc`, and authorized passwordless sudo for **fixture-only** account/server lifecycle. The script refuses an existing test account, display 95 or port 5995; generates synthetic RSA/VNC credentials under ignored `codex-work/probe`, creates restricted no-home/nologin user `okou_ra2_37499`, and starts one new 640×480 server on **127.0.0.1:5995** at a time. PAM cases run this isolated server under sudo to validate the synthetic OS account. It never rewrites PAM/global settings, changes existing TCP5901, or adds public ingress. EXIT cleanup stops only a process referencing its exact private fixture key, deletes only its account/files and reports cleanup failure.

Build the actual public fixture test, then pass its executable path (printed by Cargo):

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 \
  -p rfb-client --test rsa_aes_tigervnc --no-run
bash crates/rfb-client/tests/fixtures/tigervnc_rsa_aes.sh \
  crates/target/local/deps/rsa_aes_tigervnc-<cargo-reported-hash>
```

On an authorized lab with a separately transferred exact test binary/script, `RSA_AES_FIXTURE_ROOT` may name an isolated owned scratch parent. Do not transfer real credentials or use a production server. Record the binary SHA256 and exact source revision separately.

The sequential matrix exercises each four modes × `RequireUsername=0/1`, actual authentication, ServerInit and fresh **640×480 PNG** through the engine Session. Each case also checks a wrong password and an independently wrong pin. Successful `ne` captures are a loopback lab condition, not production raw-network approval. All eight cases passed on experimental local-11 on 2026-10-01, with 7,967-byte blank-desktop PNGs; final source/binary/cleanup checkpoint belongs in the PR acceptance record, not an inference from executable help.

## Controlled boundary coverage

Public tests separately cover all exact modes/subtypes and 255-byte UTF-8/space-preserving credentials, bidirectional post-auth transport, fragmented/coalesced records, wrong offer/pin/proof/MAC/subtype/raw transition/result, peer-size bounds, expired deadline and pending-negotiation cancellation/EOF. Native record tests cover large fragmented IO, MAC-before-plaintext and record/nonce budget. They are not the independent server matrix.

First-party wire/source evidence: [rfbproto RSA-AES](https://github.com/rfbproto/rfbproto/blob/152107db63cd34b3536ad8ddf54a0cfc9017a9f9/rfbproto.rst#L1099), [TigerVNC client](https://github.com/TigerVNC/tigervnc/blob/f885b340f29d6d24c4caf5aa6809ee4dd44101a3/common/rfb/CSecurityRSAAES.cxx), server and rdr EAX reader/writer at the same commit. Production implementation uses the specification and maintained MIT/Apache-2.0 RustCrypto libraries, not copied GPL TigerVNC code.
