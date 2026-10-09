# Desktop minimum version policy

The API owns the global Computer Use compatibility floor in
[`turbo/apps/api/src/lib/desktop-compatibility.json`](../turbo/apps/api/src/lib/desktop-compatibility.json).
Its `minimumSupportedVersion` is either `null` to disable enforcement or a stable
three-component version at least `0.51.0`. Every adjustment requires a reviewed
PR and an API release; the API serves the policy bundled with that release.
Normal Desktop releases do not raise the floor. This global policy must not be
a per-user Lab override: an unsupported host cannot opt out of admission.
Implementation and activation are tracked by [#38098](https://github.com/okou-ai/okou/issues/38098).

The configured policy is:

```json
{
  "minimumSupportedVersion": "0.51.0"
}
```

No CI, GitHub Environment, or Vercel variable sets the floor. The public policy
endpoint, host admission, and Sparkle critical-update metadata read the same
source-controlled configuration.

The `0.51.0` floor takes effect when an API release containing this configuration
is deployed. Merging the activation PR does not change a serving older API's
policy. The native `0.52.0` replacement is already published; Electron/Squirrel
and Native/Sparkle feeds both offer that version. Raising this floor does not
retire the legacy protocol's completion/stop routes or its storage.

## Admission and draining

`GET /api/desktop/compatibility` is public and returns
`{ "minimumSupportedVersion": null }` while disabled, or the configured version.
Its response is not cached. Registration and new command claims return HTTP 426
with `error.code = DESKTOP_UPDATE_REQUIRED` and `minimumSupportedVersion` for
outdated native clients. Once enabled, legacy host-token registration and claims
are rejected regardless of their claimed version. Host listings and target
selection treat unsupported hosts as offline, without revoking their connection.
The gate uses the stored host version and protocol, not optional client headers.

Heartbeat, command completion, stop, authentication, and updater/download routes
remain available with their existing authorization. A claimed command may finish
and report using its original authenticated connection. This PR does not remove
legacy token routes or storage; their separate retirement is tracked by
[#37997](https://github.com/okou-ai/okou/issues/37997).

Native Desktop checks at launch, activation, and before going online, and handles
426 from host requests. A confirmed floor/rejection is saved in its existing
preferences. Network failure, malformed responses, or an older API's 404 do not
clear it. Only a successful current policy response can lower or disable it.
An installation with no confirmed restriction may attempt registration when the
policy request is unavailable; server admission remains authoritative.

Required upgrades close local command admission and drain claimed work. Sparkle
continues to validate and install the same signed archive as ordinary updates.
The main window shows checking, download progress, preparation, draining,
installation, and errors. Installation/restart waits for reporting and host
cleanup, but bypasses the ordinary 30-minute recent-activity grace. A retry and
an official DMG download remain available if automatic installation fails.
Unsigned builds cannot exercise production auto-updates and expose the download
path instead. Optional updates retain Sparkle's standard interaction.

## Activation and rollback

1. Publish the native release containing this mechanism. Verify the replacement
   ZIP and DMG are downloadable, signed, notarized, and launchable, and the
   Squirrel `RELEASES.json` and Sparkle `appcast.xml` feeds offer a non-blocked
   replacement at or above the proposed floor. Perform the isolated signed
   native upgrade acceptance in [Desktop testing](./testing/desktop-testing.md).
2. Ensure every serving API and every API rollback candidate supports this
   policy and preserves completion/stop. Keep `minimumSupportedVersion` as `null`
   until those prerequisites hold. Review the bundled floor of every intended
   rollback target: rolling back the API also restores that release's policy.
   Do not raise the minimum as a side effect of Release Please or publishing a
   new latest version.
3. Change `minimumSupportedVersion` to `"0.51.0"` in a separate reviewed PR and
   publish the API for the first activation. Check the public policy, 426
   admission, supported registration, and both feeds. Sparkle
   items meeting the floor gain `criticalUpdate` metadata limited to installed
   versions below the floor. Older native releases receive their existing 426
   handling and Sparkle prompt; this cannot retrofit the new status page or
   automatic installation behavior into an already installed binary. Electron
   uses its existing automatic updater and the retained ShipIt relaunch bridge.
4. On a bad release, first restore an available supported candidate in the feeds.
   Lower the floor or set it to `null` through a PR and API release when restoring
   compatibility is needed. Blocked
   releases must never be the only candidate meeting the floor. Do not roll back
   to an API without the policy route while a restriction is active: clients
   deliberately retain their last confirmed restriction across a 404.
5. Retire host-token admission/readers only after this policy is live, old
   connections have drained, and the serving/rollback window excludes APIs
   that would admit them. Keep completion/stop until drain is complete, and
   drop token storage only in a later compatible release under #37997.

The Squirrel feed and ShipIt bridge remain necessary for old installations that
can skip native versions; this floor alone does not justify removing them.
