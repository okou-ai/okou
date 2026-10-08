# Archive promotion prerequisite

This is a proof, not a replacement for the current iOS CI or TestFlight release
pipeline. Simulator tests and the existing production publishing path remain
unchanged until a real device archive passes distribution export without
recompilation.

## What this PR verifies

The `iOS Archive Promotion Proof` workflow builds an **unsigned device Release
archive** with Xcode 26.3 and locked packages. It uses the production configuration,
rejects `Local.xcconfig`, and does not load signing or App Store Connect credentials.
It then copies that archive and changes the build number in the application and
archive plists. Every other file, including the executable and dSYMs, must remain
byte-identical; the original archive must remain untouched.

The unsigned archive is transferred as a private same-run artifact with the source
commit and SHA-256 digest. It is a proof artifact, not a production-ready marker or
proof that application tests passed. The PR workflow runs this part only.

## Distribution export proof

After reviewed changes have landed on `main`, explicitly dispatch
`.github/workflows/ios-archive-proof.yml` on **main**, enabling `signing_export`.
This is a separate operator action and requires the existing `production`
environment approval. It is never enabled for a PR or a dispatch on another branch.

The protected job downloads the archive from the same run, validates provenance
and the archive digest, changes its build number to **9999**, and calls:

```sh
bash ios/scripts/release-testflight.sh --verify-archive <Original.xcarchive>
```

This mode uses the existing distribution certificate/profile checks and cleanup,
but does not resolve packages, compile, query App Store Connect, or upload an IPA.
The only Xcode action is `-exportArchive`. It has no compile-on-failure fallback.

Acceptance requires:

- Xcode exports the previously unsigned archive with App Store Connect manual
  distribution signing and the existing internal-only export policy.
- The exported bundle ID, release version, and final build number are correct.
- Every archived Mach-O file retains its compiled sections after export, excluding
  the signing/link-edit region. The original unsigned archive remains available
  for comparison. Export may add distribution runtime files.
- `codesign --verify --deep --strict` passes, and the exported app has the expected
  distribution team/application entitlements with `get-task-allow` disabled.
- No TestFlight upload occurs and no signing material or exported IPA is retained
  as a workflow artifact. The temporary signing keychain/profile/files are removed.

If export rejects unsigned archives or the checks fail, the prerequisite has **not**
passed. Inspect the native Xcode error before choosing a different archive-signing
strategy; do not switch the production pipeline or retry by recompiling.

This proof does not establish App Store Connect acceptance, device installation,
or the absence of every conceivable compiler/linker transformation. The section
fingerprints establish preservation of the archived compiled sections; native
signature checks establish the local export's signing validity.

## Follow-up after the proof passes

Adopt Turbo App's build/consume separation rather than its SHA resolver blindly:

1. Ordinary PR merge groups run build and tests, with evidence bound to all relevant
   iOS source, dependencies, build configuration, and toolchain inputs.
2. Release-only merge groups verify that evidence and allowlisted metadata changes,
   then build and persist the device Release archive, manifest, and final readiness
   marker. Mixed groups containing unverified code must not skip tests.
3. Publish an explicit mapping from the release target to that verified archive.
   Merge-group and main SHAs are not assumed to match. Preserve the original builder
   commit and checksums; never use the most recent successful archive as a substitute.
4. The main release publishing job waits for the exact mapped archive, verifies it,
   obtains the next build number, exports/signs, and uploads to TestFlight. Missing
   evidence/artifacts or identity mismatches fail closed; no build/test fallback.

The current `deploy-app` readiness marker establishes completed artifact upload,
not passing tests. Keep test evidence separate from build readiness in the iOS
promotion design too.

## Local checks

```sh
python3 ios/scripts/archive-proof.test.py
bash -n ios/scripts/build-archive-proof.sh ios/scripts/release-testflight.sh
shellcheck ios/scripts/build-archive-proof.sh ios/scripts/release-testflight.sh
```

These tests run the real preparation/verification commands against temporary
archives and IPA containers. Their generated Mach-O/signature placeholders test
metadata and section-fingerprint contracts only; they do not substitute for
building the actual app or the protected distribution export proof above.
