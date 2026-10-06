# QEMU verified-X509263 / GSSAPI engine fixture

This is engine/protocol interoperability, not Owner→Agent→Runner product acceptance, compatibility with every QEMU release, merge permission or production activation. #37612 leaves #37613 and `VncAccess.enabled: false` unchanged. SCRAM remains a separate profile; rsasl's ambient GSS backend is not enabled.

## Independent server and client identity

The local server is QEMU **9.2.0**, source commit `ae35f033b874c627d81d51070187fbf55f0bf1a7`, archive SHA256 `f859f0bc65e1f533d040bbe8c92bcfecee5af2c921a6687c652fb44d089bd894`, `ui/vnc-auth-sasl.c` SHA256 `3dfd2c4be76597983641fde3d99b64ac5b0d6a56b59e4d6a08edacc95075bc2d`. The audited local fixture binary is SHA256 `cef1a9a4a18daad78f74b4997fafdb3c18aeaead1596732bf6c5bc5bb32eabc8`; the harness refuses a substituted binary. QEMU 8.2.2's GSS token/NUL behavior is not a reason to weaken parsing.

Independent private server/KDC libraries came from signed official Ubuntu Noble package indexes: Cyrus `2.1.28+dfsg1-5ubuntu3`, MIT `1.20.1-6ubuntu2`, GnuTLS `3.8.3-1.1ubuntu3.6`. These are fixture identities, **not** the production client's maintenance/security baseline. The client uses the sealed, separately built MIT1.22.2/musl worker described in [`../../kerberos-worker/README.md`](../../kerberos-worker/README.md).

TLS `localhost`, the loopback TCP destination and the explicit same-realm `vnc/<fixture-instance>` service are independent identities. The library does no TCP/DNS/KDC discovery. Two synthetic realms use independent exact caller routes, locally generated AES17/18 keytabs/passwords/service-only caches, and a private synthetic TLS CA. Password leading/trailing spaces are intentional. None is a real account credential.

## Reproduce

Use the pinned private QEMU/server-runtime build described above, not a system GSS client or an arbitrary executable override. From the repository root:

```bash
python3 crates/rfb-client/tests/fixtures/qemu_gssapi.py \
  --runtime-dir codex-work/probe/issue-35048-gssapi/root \
  --qemu codex-work/probe/issue-35048-gssapi/qemu-build-9.2.0/qemu-system-x86_64
```

Both modes require a nonsymlink `provider.json` recording the actual private runtime's package identities and extracted regular-file SHA256 values. Those records must come from verified signed official archives, not from hashing an arbitrary installed tree. Before compiling, generating credentials or starting a KDC/QEMU, the harness rechecks every recorded file, the used MIT/KDC tool paths and contained library aliases. The manifest and each required native MIT/Cyrus/GnuTLS package must declare the selected Debian architecture (`amd64` for `x86_64-linux-gnu`, `arm64` for `aarch64-linux-gnu`); a matching layout/version string alone cannot admit an absent or cross-target architecture record. Full mode additionally requires the pinned Cyrus/GnuTLS package records, Cyrus GSS plugin and BIOS file records. A missing/mismatched record or escaped alias refuses; there is no legacy manifestless full-mode fallback. The independent-MIT provisioning script produces only the controlled-peer runtime; it does not produce the complete QEMU/Cyrus/GnuTLS/BIOS bundle. The historical full command above therefore still needs separately verified full input artifacts and a reproducible provision/build recipe; this input guard is not a new full-QEMU runtime receipt.

The full fixture's explicit `pinned-host` independent MIT acceptor remains distinct from the controlled fixture's `signed-private` acceptor. Its host package-version check is not an actual loaded-library hash/loader map. Private file/manifest equality likewise does not prove exhaustive transitive dependencies, plugin loading or the original historical runtime. Those acceptance boundaries remain required, not waived by this preflight or the controlled-peer receipt.

The harness compiles the current Rust test target and owns only its synthetic loopback listeners/processes/private generated directory. Secrets go through private stdin/files, never CLI arguments or environment values. Public fixture-directory/stopped-KDC indicators select the opt-in test target; default ignored tests are not an acceptance result. Cargo/test descendants run in an owned process group; the harness is a subreaper and verifies descendant termination/reap, listener closure and exact secret-tree removal even on timeout/failure. Actual native child reaping is checked by process tests and completed-context/finality controls, not inferred merely from the intentionally unlinked input directory. Do not use external hosts/KDCs, public ingress, global Kerberos/PAM/SSH settings or retained credentials.

## Rebuilt full-private candidate producer

```bash
bash .github/scripts/check-full-qemu-producer.sh
```

The separate native x86_64/aarch64 CI producers download the complete
Depends/Pre-Depends closure from signed Ubuntu snapshot `20260521T000000Z` into
an empty private APT state. Exact MIT/Cyrus/GnuTLS identities above are retained;
compiler, libc, Python/venv, shell/tools and development seeds are explicit.
Archive hashes are checked against signed metadata before collision/path-safe
extraction. No package installation or maintainer script runs. Declared usrmerge,
compiler/rmt/UTC aliases and a bundle of signed public CA certificates replace
only their normal maintainer-generated inputs. Dangling package documentation
and non-C locale aliases remain recorded, not executable/library/configuration
inputs or host fallbacks.

QEMU9.2 source and VNC hashes are unchanged. The producer runs the native signed
compiler/Python in a private read-only input root, ordinary-owner build directories
and disposable mount/PID/network namespaces. Archive-covered Meson wheels are
used offline; subproject downloads, modules, plugins and KVM are disabled. Two
separate generic-ISA builds must produce identical native ELF bytes. The guest
emulation target remains `x86_64-softmmu` on both native hosts. BIOS/VGA firmware
is separately hashed against exact members of the pinned QEMU release archive,
not a host firmware directory.

`full-qemu-producer-receipt/` retains actual candidate QEMU bytes, original signed
InRelease indexes, compiler log, package/file/alias closure and producer identities.
Its receipt deliberately has `runtimeVerified: false` and
`attributionVerified: false`: successful builds do not complete full-ten/PNG or
loader acceptance. Independently reviewed actual binary/recipe/package-lock pins
must be recorded in `qemu_gssapi_full_pins.json` before the explicit
`--source-built-full-private` mode can admit a producer. The initially empty pin
map refuses before credentials/KDC/QEMU; an arbitrary rehashed tree cannot approve
itself. This mode is distinct from legacy `--qemu`/`pinned-host` and
`--controlled-peer-only`/`signed-private`; neither is reinterpreted as a fallback.

Full-private execution additionally needs the private-root harness, actual
interpreter/transitive/late-plugin/short-lived-tool and firmware/data attribution,
the unchanged ten tests on both native hosts, their actual 640x480 PNGs and checked
teardown. These mandatory inputs/executions are **not yet completed** by the
candidate-producer patch. No K2, six-pass review, non-root or production readiness
is implied. The optional `QEMU_GSSAPI_CAPTURE_DIR` is only a public image-receipt
destination for actual fixture frames, never a backend or native-helper override.

## Native independent-acceptor CI

```bash
bash .github/scripts/check-native-gssapi-peer.sh
```

The separate Crates `native-gssapi-independent-peer` matrix runs on native x86-64 and ARM Linux, without emulation. It builds the current Rust test target unprivileged and downloads the exact MIT `1.20.1-6ubuntu2` acceptor/KDC packages through signed official Ubuntu Noble indexes. Archive SHA256, package/version/architecture and extracted file digests are checked; packages are **extracted, not installed**, and host apt/Kerberos configuration is unchanged. The independent acceptor uses only those private libraries; the production MIT1.22.2/musl helper has no override. Fixture-only event-loop and CLI dependencies are also bound to the signed Noble metadata.

Runtime explicitly uses the existing disposable privileged-synthetic mount/PID harness, not a production elevation or a non-root availability claim. Two synthetic loopback KDCs and their private native input roots use a bounded child-only 64 MiB/256-inode `/run` tmpfs; host `/run`, ancestor permissions, sysctl/AppArmor and unchanged worker isolation are not modified. No credentials are supplied by the user or retained. The `--controlled-peer-only` mode is explicit and mutually exclusive with the hash-pinned `--qemu` mode: it is not a fallback for unavailable QEMU.

The native driver first runs the separate standard-library `qemu_gssapi_runtime_test.py` input-integrity suite. Its inert file/manifest canaries are never loaded or executed and do not fake native results or attest signatures/runtime interoperability; they test the preflight's digest, package, path and used-input refusal contracts. The native runtime result groups and seven opt-in tests remain distinct.

Seven opt-in tests execute a timed acquisition/expiry regression, two real keytab/password renewal/reacquisition tests and the four existing tests' 25 meaningful controls: independently verified mutual GSS/RFC4752, corrupt AP-REP/MIC, confidentiality/layer/maxbuf/length/sequence refusal, retained completed-GSS expiry, actual verified-TLS RFB finality/padding/SecurityResult, and AP-REP/layer/SecurityResult stalls at acquired expiry. Existing assertions, lifetimes and deadlines are unchanged. The new regression supplies real five-second KDC latency with an eight-second requested ticket: acquisition must not backdate a still-valid ticket to before KDC work, but it must still refuse at the actual native endtime rather than grant a fresh requested lifetime on receipt. It verifies initial AP-REQ eligibility, later `Expired`, actual helper disappearance and empty private resources. It does not complete mutual GSS by itself. The renewal tests use only the independent signed KDC and public native worker APIs, not QEMU; both preserve the original lifetimes/deadlines, refuse distinct expiry/nonrenewable/exhaustion states without KDC traffic or implicit reacquisition, and explicitly verify actual helper disappearance and empty resources for keytab and password sources. All native/acceptor/KDC children, listeners and private material must actually be cleaned. `crates/target/native-gssapi-peer-receipt/` records the exact head/dirty flag, architecture/helper/test/provider digests and results; `runtimeVerified` becomes true only after all seven tests and cleanup succeed. A missing, failed, dirty or older receipt does not establish current-head ARM interoperability.

This is independent mutual-GSS/verified-TLS RFB-control evidence, **not** source-pinned ARM QEMU/Cyrus PNG, complete product acceptance or every hostile completed-context field. The original full QEMU command and its ten tests, including the new timed acquisition regression, remain separately required for that fixture's scope.

## Matrix and limits

- Actual password and keytab AS/TGS plus verified TLS, mutual GSS, integrity-protected RFC4752 no-layer selection, complete SecurityResult/ServerInit and 640×480 PNG.
- Two concurrent distinct realms/initiators with independent checked caller transports and MEMORY handles.
- Prefetched service-only imports after both KDC processes are stopped: successful PNG and **zero** caller KDC exchanges. Missing/expired input is not an online fallback.
- Wrong TLS/name, current authority, password/keytab and service refuse; changed current authority blocks the next actual KDC exchange. Online sources against actually stopped KDC listeners report `KdcUnavailable` without retry. A caller-injected `DeliveryUnknown` is observed once and never replayed; it is not proof a real packet had uncertain delivery or a ticket was revoked.
- Actual native renewal extends new ticket metadata; nonrenewable, expired initial-ticket with still-live renew-till, and exhausted renew-till controls refuse in distinct categories without KDC traffic or automatic reacquisition. Explicit same-source reacquisition after expiry succeeds only as a future handshake source. No active RFB deadline is extended.
- Established sessions separately reach a selected three-second Run deadline and an acquired four-second ticket/GSS bound, with a still-live 60-second Run, and close. Stalled controlled peers also withhold AP-REP, the authenticated layer offer or SecurityResult after real four-second AS/TGS acquisition: the original TLS stream closes at the earlier acquired ticket/completed-GSS bound, not its ten-second handshake or 60-second Run deadline. Neither is full product/idle-owner acceptance.
- The independent maintained MIT acceptor (`mit_gss_peer.py`, fixture MIT1.20.1, no custom GSS/crypto) actually verifies a valid mutual context and no-layer selection. The public worker retains the earlier rounded-down completed-GSS expiry, even while the source ticket and original operation deadline remain live: no-layer selection at that reported bound refuses `Expired`, closes the real helper and produces no response for the independent acceptor. The pre-repair regression independently verified an authentic no-layer response after that bound, rather than inferring expiry enforcement from an internal counter. Corrupt AP-REP/MIC, confidentiality, incorrect layer bits/maxbuf/length and an authenticated sequence gap refuse. Controlled RFB/TLS peers backed by that acceptor verify NULL/empty final success and reject early/invalid finality, absent/empty/oversized/padded-invalid tokens, post-selection data and a rejected SecurityResult.
- `qemu_gssapi_framing.rs` separately checks subtype/mechanism aliases and malformed offers before native credential authority, plus pending-authority deadline/cancellation and original-stream closure. Nested acquired-ticket/GSS/native deadlines retain the public RFB authentication-deadline/stage category. A paused-clock phase regression releases a pending gate exactly at expiry and independently verifies that no output byte is sent: rejecting the result only after credential output would not enforce that boundary.

Public process canaries separately cover exact encoded-ticket service/realm/case and canonical DER framing (including suffix/concatenation refusal), absent-versus-empty/oversized/malformed GSS states, real queue/process capacity, authority/KDC cancellation, idle deadline/reaping, cleanup uncertainty/quarantined capacity and subsecond timestamp mapping. Their fake zero-key tickets are never delivered to a peer and are not mutual authentication.

Both architecture containment/package/cleanup receipts must come from the current Crates native matrix, not older static probes or user-mode emulation. They do not by themselves prove mutual GSS/RFB. The separate native independent-acceptor receipts above cover only their executed protocol controls; source-pinned ARM QEMU/Cyrus PNG and local ARM execution are not inferred. Completed-context MIC/finality controls above do not prove every hostile name/mechanism/flag/QOP or bootstrap interleaving. The separate native matrix covers one actual unauthenticated high-cost preauth/CPU-limit/reap/admission control and one stopped-worker/actual-parent-death interleaving after Ready but before credentials, as documented in the worker README; these are not broad CPU/DoS/bootstrap coverage or mutual GSS interoperability. An earlier local renewal-test invocation observed `Expired` during initial acquisition; later isolated and full runs passed, which does **not** establish its cause or prove a flaky-test diagnosis. Preserve that unresolved observation in current-head review/acceptance. The later same-source reacquisition `Invalid` observation was investigated separately: pinned MIT reads `kdc_timesync` as an integer, so the former `false` value silently retained enabled clock-offset adjustment. A maintained-library effective-flag proof, authenticated synthetic Ticket timestamps and the uninstrumented full fixture after the numeric-zero repair support that diagnosis. Both private profiles now use `0`; malformed readonly profiles refuse before Ready, and no timestamp predicate, assertion, lifetime or timeout was relaxed.

Engine evidence does not complete product custody/KMS, exact KDC permissions, saved capabilities/DTO/App, real Run handoff or production readiness.
