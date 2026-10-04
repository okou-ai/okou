# kerberos-worker

A safe-Rust owner for one isolated, private MIT Kerberos/GSS initiator. This is an engine component, not a saved profile, a destination connector or permission to enable VNC.

## Sources and identities

`Credentials` separates the explicit initiator and exact same-realm `vnc/<instance>` target from the TCP host and TLS name. `Source::Ticket` consumes a K1 service-only canonical FILE4 cache; `Source::Password` and `Source::Keytab` explicitly acquire same-source AS/TGS credentials. Imported tickets never acquire, renew, discover a KDC or fall back. Passwords preserve 1–1023 UTF-8 bytes, including spaces, without classic-VNC truncation. K1 remains a no-crypto parser.

Before storing any service ticket, the pinned MIT decoder/encoder requires exactly one canonical DER Ticket and compares its unencrypted realm/components/case with the requested target and cache metadata. MIT's decoder alone ignores trailing bytes. This is structural binding, **not** authentication of the encrypted ticket, its client, expiry or revocation. Mutual GSS must complete, with the exact Kerberos mechanism, initiator/service identities, positive finite lifetime, MUTUAL/REPLAY/SEQUENCE/INTEG and no delegation/anonymous flags. RFC4752 unwrap/wrap accepts only an integrity-protected, default-QOP four-byte no-layer offer and implicit authorization identity.

## Native package and updates

The native package build targets are Linux x86_64/aarch64, static musl, MIT **1.22.2** (`8570e77819563e036027e1da789d08ec9333ed4d`), built-in crypto, no shared-library/runtime executable override. Official source archive SHA256: `3243ffbc8ea4d4ac22ddc7dd2a1dc54c57874c40648b60ff97009763554eaf13`. Zig **0.15.2** has separately pinned official x86_64/aarch64 host archives in `native/build.sh`. Cargo verifies the sealed ELF digest and embeds the helper in consumers which actually use the native engine; native inputs follow the existing committed Runner build-input inventory. K2 does not make Runner's saved profiles call this backend, and this is not a receipt for an optimized/distributed Runner release.

An SDK/toolchain update must verify official source/archive provenance, update the notices, review the mirrored private `encode_krb5_ticket` declaration against MIT `src/include/k5-int.h`, review syscall/constructor/plugin behavior and repeat both-target closure/runtime and independent interoperability. Library cache identity includes source/toolchain/architecture and the build recipe, so an old existing archive cannot survive a pin/flag change as a newly labeled package. Attribution is checked byte-for-byte against fetched sources, accompanies the helper build as versioned notice files, and is exported as `NATIVE_NOTICES`. `Resources::create` verifies the notice digest through a live reference, and the native driver checks retention in actual linked test consumers. This is not attribution embedded in the standalone helper ELF or proof of an optimized/distributed production Runner artifact.

Other Unix targets or unsupported kernel/bootstrap/ABI/package conditions return `Unavailable`, never another backend. Non-Unix builds are not supported. Native support does not advertise a product capability.

## Isolation and ownership

The supplied root must be absolute, canonical, nonsymlinked, owned by the current effective UID and exactly 0700. The parent makes a fixed empty private file set. Before secret-free Ready, the worker installs a private user/mount namespace, a readonly minimal root, closes unrelated descriptors, drops capabilities/dump privileges, requires Landlock ABI >=3 and installs architecture-checked, default-deny seccomp. Host/proc/sibling paths and metadata, plugins, DNS, sockets, fork/exec, process-memory and filesystem mutation are absent or refused. Static library constructors register local tables/locks; profile/mechanism discovery occurs only inside the private root.

After Ready, the parent unlinks **all names before writing any secret** into the held readonly-bind input inodes. Native cache handles are explicit MEMORY caches; the GSS service-only handle is separate from online TGT/renewal state. No secret argv/environment/log/diagnostic causes are emitted. Every native process has finite memory/FD/CPU (12 seconds) and absolute wall (30 seconds, including admission) bounds. Queue <=16 and actual workers <=2. Cancelled bootstrap/authority/KDC/native futures stop actual work, not only a waiter. Slots remain held through kill/wait/pipe closure/verified cleanup. Unknown cleanup retains fail-closed capacity; restoring a path does not prove cleanup or authorize clearing it.

`Context::close` confirms resource completion. `Drop` signals an independently owned reaper; it is not a synchronous completion receipt. Owned Rust buffers/tokens are zeroized, but upstream/compiler/kernel copies cannot all be guaranteed erased. No writable native cache directory or global kernel/credential configuration workaround is allowed.

## KDC and expiry

`KdcExchange` is an independent caller authority/transport boundary, not the VNC/SSH route. The caller must authorize exact current owner/Run/source and, inside `exchange`, recheck a separately permitted exact realm/KDC route at actual connect/send. It must bound allocation before producing a reply. The worker supplies no destination. Messages are 1–64 KiB, <=16 exchanges and <=512 KiB total per context, under the shared deadline. The owned open/command future checks that deadline before every poll: a pending caller, queue or bootstrap gate becoming ready at expiry cannot resume IO before a later result check rejects it. `DeliveryUnknown` is terminal and never replayed; neither cancellation nor closing proves ticket revocation. `NoKdc` is engine/fixture-only, not product authorization.

Both the fixed readonly GSS profile and the explicit acquisition profile set the maintained MIT **integer** `kdc_timesync = 0`, not the silently defaulted boolean string `false`. The readonly profile is checked before Ready/any credential, and the explicit profile before acquisition; KDC replies cannot redefine the caller/local-clock expiry boundary. Imported/native absolute timestamps map conservatively to monotonic time without rounding the current wall clock to whole seconds. Completed GSS whole-second lifetimes are rounded down. Long-lived standard tickets are allowed, while the RFB owner clamps authentication to the earliest ticket/GSS/Run/session bound and its existing two-hour cap. Status is metadata, not authenticated ticket endtime. Renewal/reacquisition only produces a future handshake eligibility; it cannot extend, reconnect or replay an established stream. The outer owner must close idle sessions at expiry/Run cancellation.

## Verification

```bash
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 -p kerberos-worker
cargo test --manifest-path crates/Cargo.toml --profile local --locked -j 1 -p kerberos-worker \
  --test process --test cleanup_unknown -- --include-ignored --test-threads=1
```

Strict native tests need a supported kernel/namespace environment; generic container coverage tests explicit native unavailability and does not pretend skipped runtime tests passed. Host LSM policy can make an unprivileged caller unavailable even when the kernel has namespaces/Landlock. No production privilege elevation, host-policy change or alternate backend is supplied.

The Crates matrix compiles unprivileged and first checks the original build UID's availability/refusal with capabilities removed. It explicitly selects `--privileged-synthetic` for the strict positive unit/pipe/ownership/process tests, inside disposable mount/PID namespaces on real x86_64 and ARM64 kernels. This retains the existing sudo fixture harness's privilege **only before bootstrap**; the unchanged worker must drop all capabilities, install its readonly root/Landlock/seccomp and pass self-checks before Ready or any synthetic credential. It does not establish unprivileged availability on Ubuntu's restricted host policy. No sysctl/AppArmor/device/credential policy is changed. The synthetic-root resources live on a bounded child-only tmpfs, never in another UID's private checkout ancestors or a modified host `/run`. The receipt records the runtime profile/UID and separate owner-bootstrap outcome, not just a passing test count. PR native jobs explicitly check out the PR head, while main/merge-group jobs use their actual event revision.

A public process regression waits for the real helper's synthetic AS request, releases a pending caller transport gate after the shared deadline, and independently observes EOF with no canary byte, actual process disappearance, empty private resources and replacement admission. It uses the real clock for native/kernel IO, not a paused Tokio clock or a fake helper; it does not claim real KDC packet uncertainty or mutual GSS authentication.

Exact-head ELF/digest/runtime receipts remain a gate when Rust coverage is selected; a dirty local receipt is explicitly labeled and does not attest committed HEAD. Cross-compilation, emulation and older package receipts do not replace either runtime result. Independent mutual GSS/RFB fixtures are documented in `../rfb-client/tests/QEMU_GSSAPI.md`; public zero-key canaries prove structure/ownership only and are never sent to a peer.
