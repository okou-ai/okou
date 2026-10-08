# Bounded Kerberos credential import

A native-dependency-free, no-I/O format boundary for the QEMU Kerberos work in
[#35048](https://github.com/okou-ai/okou/issues/35048). It parses explicitly selected
FILE credentials and reconstructs a limited canonical representation before a
future native consumer receives them. It does **not** add an RFB authentication
profile, capability, KDC connection, saved credential, or product support.

## Public boundary

- `Principal::new(realm, components)` validates an explicit structured identity.
  Comparison preserves case, UTF-8, and component boundaries; `/`, `@`, and `\`
  inside a component are not separators. A native consumer must escape names
  correctly and validate its additional hostname/realm policy.
- `ServiceTicketCache::parse(input, initiator, server, now)` consumes an owned
  FILEccache4 and retains exactly one same-realm `vnc/hostname` service credential.
  The caller supplies time explicitly; there is no ambient clock, account, file,
  cache collection, keytab, DNS, or network lookup.
- `ClientKeytab::parse(input, initiator)` consumes an owned FILEkeytab2 for exactly
  one principal and reconstructs explicit AES key versions.
- `canonical_bytes()` borrows secret material for a future private native/KMS
  boundary, not logging or guest output. `declared_expires_at()` is upload metadata.

Constructors return static error categories without input bytes, names, paths, or
native diagnostic causes. Credential owners have no `Clone` or byte-exposing
`Debug`/`Display`. Principal `Debug` is also redacted; principal accessors deliberately
expose identity metadata, not cryptographic credentials.

## Supported subset and budgets

| Boundary                  | Limit / policy                                       |
| ------------------------- | ---------------------------------------------------- |
| Owned input               | 64 KiB for either format                             |
| Principal                 | 1–8 components, nonempty realm                       |
| Each realm/component      | 255 UTF-8 bytes, no NUL/control characters           |
| Combined principal bytes  | 1,024, exact case-preserving comparison              |
| FILE name types           | 0–3; enterprise and other variants rejected          |
| Cache header              | 1,024 bytes / 16 tagged fields                       |
| Cache credentials         | 64, including discarded entries                      |
| Opaque ticket             | 1–48 KiB for the selected service                    |
| Address / authdata lists  | 16 entries each, each data field at most 8,192 bytes |
| Selected service lists    | Addressless / no per-credential authdata initially   |
| Selected service keys     | AES17/18, respectively 16/32 bytes                   |
| Selected service variants | No user-user or secondary ticket                     |
| Selected time fields      | Finite positive i32 epoch range, consistent ordering |
| Keytab signed records     | 64, including holes and a supplied end marker        |
| Keytab keys               | 16, one explicit initiator, AES17/18, positive kvno  |
| Keytab ambiguity          | Duplicate effective kvno/enctype rejected            |

All counts and lengths are checked before slicing or allocating from them. Every
cache record is parsed even when discarded. Malformed/truncated discarded records
or trailing bytes refuse; unsupported selected variants do not fall back to a
native/raw importer. Transport consumers must enforce the input bound **before**
allocating an owned input; an oversized buffer passed here is rejected and still
zeroized, so its cleanup cost depends on the buffer the caller already allocated.

### Service-cache normalization

Only FILE version 4 is supported. The parser reads the entire header; the known
time-offset tag must be exactly eight bytes. Unknown well-formed tags are ignored
as the format specifies. The output has an empty header and never adjusts the
caller's clock from upload data.

Default and every entry's client must match the explicit initiator. Exactly one
entry must match the same-realm, two-component `vnc` service. TGTs, other services,
`X-CACHECONF` records, proxy/refresh/referral/preauth configuration, and all header
values are parsed, bounded, discarded, and never forwarded to native libraries.
The selected credential retains validated key/ticket/flags/time bytes, with empty
address/authdata/secondary fields and ordinary canonical client/service name types
1/2. These name-type labels do not change the structured identity.

Effective start is `starttime`, or `authtime` when the FILE field is zero. Require
`0 < authtime <= effective_start < endtime`, renewal time zero or at least endtime,
and `effective_start <= now < endtime`. No clock-skew offset, lifetime extension,
renewal, other source, or ambient fallback occurs.

### Keytab normalization

Only FILE version 2 is supported. Negative records are bounded, zero-filled holes;
`i32::MIN` cannot overflow a signed absolute value or allocate its indicated size.
A zero end marker is accepted only at physical EOF. Positive entry padding is
bounded and discarded. An optional nonzero 32-bit key version overrides the
8-bit version, exactly as the native format specifies; a zero wide value leaves
the low version in force. Effective version zero refuses.

The output is sorted by effective version and enctype, uses minimal positive
records and an explicit 32-bit version, ordinary name type 1, and informational
timestamp zero. No holes, padding, other principal, or extra account source is
retained. Informational keytab timestamps do not describe credential lifetime.

## Trust and secret ownership

These are **format checks, not cryptographic authentication**. Ticket contents,
keys, client metadata, and timestamps arrive from an uploader. Only a later native
Kerberos exchange and authenticated server can accept the actual ticket/session
key. RFC4752 does not export the server-verified ticket endtime to this parser.
Declared/native cache lifetime must not be advertised as independently learned
cryptographic expiry or global revocation. Cache renewal also does not extend an
already-established GSS/RFB context or authorize reconnect/input replay.

Input and canonical buffers use `Zeroizing<Vec<u8>>`, including rejected owned
inputs. Canonical builders preallocate finite capacities to avoid reallocation
while copying secret material. There are no secret-bearing `Clone` or formatted
errors. This is not a guarantee that upstream callers, native libraries,
compilers, allocators, kernels, or existing copies erase every byte. Consumer
custody, KMS, current owner/Run authority, native resource/route/package isolation,
TLS/GSS identity, and product acceptance remain separate requirements.

## Verification

Public integration tests build independent synthetic structural binary records,
not real tickets or live key material. They exercise selection/canonical bytes,
identity/variant/time/budget rejection, EOF/truncation/malformed mutations, signed
holes/padding/version behavior, and redaction. Synthetic byte acceptance does not
prove native cryptography or product interoperability.

`tests/fixtures/conformance.tsv` supplies language-neutral golden vectors for a
future API-side decoder: tab-separated case/mode/input-hex/canonical-hex/error,
fixed `alice@EXAMPLE.INVALID`, `vnc/host.example.invalid@EXAMPLE.INVALID`, and
explicit time 200. `Ok` means accepted with the exact canonical bytes.
These are deliberately synthetic keys/opaque tickets, not live credentials.

```sh
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 -p kerberos-credentials
cargo clippy --manifest-path crates/Cargo.toml --profile local --locked -j 1 -p kerberos-credentials --all-targets -- -D warnings
cargo doc --manifest-path crates/Cargo.toml --profile local --locked -j 1 -p kerberos-credentials --no-deps
cargo fmt --manifest-path crates/Cargo.toml --all -- --check
```

## First-party format references

- [MIT1.20.1 FILE credential-cache format](https://github.com/krb5/krb5/blob/e35b32f81f9defbcce4f2398d93a975ffb807ee7/doc/formats/ccache_file_format.rst)
- [MIT1.20.1 FILE keytab format](https://github.com/krb5/krb5/blob/e35b32f81f9defbcce4f2398d93a975ffb807ee7/doc/formats/keytab_file_format.rst)
- [RFC4752 GSSAPI SASL](https://www.rfc-editor.org/rfc/rfc4752.html)
- [Parent dual-mode plan](https://github.com/okou-ai/okou/issues/35048#issuecomment-5965514972)
