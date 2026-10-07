# Tailscale reader preparation and release boundary

The initial Tailscale delivery is split between compatible App readers and later
backend producers. Every production release still promotes **API before App**.
The early reader must be available in a completed earlier App release before a
later producer release can require it. Separate PRs collected into the same
unreleased release do not establish this boundary.

## Reader-only source slice

[#37811](https://github.com/okou-ai/okou/issues/37811) prepares the existing App
for saved SSH metadata with either a bound
`{ type: "tailscale", configId }` transport or a retained
`{ type: "tailscale", needsRebind: true }` transport. Direct and Cloudflare
response shapes and create/update input schemas remain unchanged.

The App identifies the actual carrier in the SSH list and latest-settings
conflict review. It does not open the legacy Direct/Cloudflare editor for a
Tailscale host. Explicit host-key reset and deletion retain their confirmation,
current-generation conflict review and explicit-retry behavior; merely reading
a host does not change its carrier, login, pin or permissions. If a generation
conflict reveals that a host changed from Direct/Cloudflare to Tailscale while
its legacy editor was already open, the App keeps that edit blocked and asks
the user to cancel. It never accepts the newer generation to resend the old
carrier draft. Explicit reset/delete conflict review remains supported.

An SSH-backed VNC host distinguishes retained Tailscale from retained Cloudflare
and continues to react to SSH metadata refresh. While Tailscale setup is not
available here, the warning says so rather than directing an owner to a
Cloudflare binding, Direct conversion or unavailable editor. Full setup and
switch-on recovery remain
[#37640](https://github.com/okou-ai/okou/issues/37640).

This preparatory slice adds **no Tailscale producer**: no selected/inline
Tailscale write input, configuration CRUD/conversion route, new persistence or
migration, JIT/native capability, setup form, feature-switch activation or
web-client floor increase. Reading saved metadata is not an operational
Tailscale session or proof of official SDK/provider/fleet qualification.

## Real release prerequisite

[#37812](https://github.com/okou-ai/okou/issues/37812) owns the readiness evidence
before [#37638 / backend PR #37651](https://github.com/okou-ai/okou/pull/37651)
is eligible for the later producer/floor release:

1. Complete the reader PR's review, current-head required CI and source
   acceptance, including SSH and SSH-backed VNC.
2. Under separately authorized release operations, verify the App containing
   that source is **actually serving in production**. Record its semantic
   version, commit/artifact ancestry, release/deployment identifiers, observation
   time and serving evidence. A merged PR, tag, version or immutable build is
   not sufficient.
3. Keep reader and producer/floor in different completed releases. Only the
   later backend may require the earliest verified sufficient live reader
   version, retaining an already-higher valid floor. Do not guess a future
   version or require the later full-setup UI release unnecessarily.
4. Verify the existing identified-App 426/no-store flow can refresh into that
   already-live reader during the later API-first promotion. An App introduced
   only by that same release cannot be assumed available yet.

No sufficient production Tailscale-reader version is selected by this source
slice. Until the readiness evidence and selected floor are complete, #37651
remains Draft and is not eligible for a protected merge or producer release.
The general floor intentionally does not reject every non-App caller or every
missing/malformed version; it is not authorization or a producer/fleet barrier.

See [deployment compatibility](deployment-compatibility.md) for the existing
API-before-App lifecycle and staged reader/writer precedent.

## Independent backend and native gates

The reader split does not make the canonical transport schema rolling-writer
compatible. The backend retains required `direct | cloudflare_access | tailscale`
transport with no carrier default, matching-reference-derived rebind and a
checked outgoing-reader shadow. Before its migration, separately authorized
operations must quiesce/drain outgoing mutation handlers, in-flight writes and
reachable rollback writers, then apply the schema and promote/verify explicit
writers before writes resume. Compatible serving/rollback API and cached App
readers remain independently necessary; a web floor protects neither old API
serializers nor rollback writers.

The default-off `TailscaleAccess` / `tailscaleAccess` switch belongs to full
Platform setup and is **UI-only**, never an API/Runner availability gate.
Hiding UI is not revocation, a data-write barrier or rollback protection.
[#37639](https://github.com/okou-ai/okou/issues/37639) still owns official native
Rust SDK qualification and eligible fleet support before usable JIT. Independent
native and full-UI work can proceed where the actual contracts permit; file
overlap alone is not a dependency.

Source submission does not authorize a queue/merge, migration, writer drain,
deployment, provider operation, audience enablement or activation, and does not
complete the [#36137](https://github.com/okou-ai/okou/issues/36137) parent.
