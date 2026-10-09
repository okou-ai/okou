# iOS archive promotion

The iOS pipeline separates merge-group validation/builds from production signing,
export, and TestFlight publication. Main never resolves packages, compiles, or
runs simulator tests to recover a missing archive.

## CI and test evidence

`.github/workflows/ios.yml` runs simulator checks on ordinary PRs and dispatches.
A main merge group with changed iOS inputs also builds an **unsigned device
Release archive**, with locked Swift packages and no production credentials.
Simulator validation and device compilation run in **parallel macOS jobs**, each
with a 15-minute limit, rather than serializing them past the live merge queue's
15-minute check-response window. The simulator checkout retains bounded queue
ancestry (32 commits; the current squash queue merges at most five entries); the
archive builder needs only its own commit. Only release-only groups install an
R2 client on macOS to resolve potential prior evidence.

Both native jobs must succeed before the Ubuntu publisher writes canonical
objects. The publisher compares their independently captured **complete input
fingerprints and toolchains**, rejecting a missing or mismatched simulator
record. It verifies the tar checksum produced on macOS before transfer and
checks archive provenance against `build-archive` and test provenance against
`build-test`, using each producer's exact run attempt. The required `ci-gate-ios` includes
both native jobs and publication, not just compilation.

A release-only merge group can omit simulator tests only when an existing test
record matches its complete test input fingerprint. The classifier examines the
**whole group's diff**, not its branch name or last commit. Its conservative
allowlist accepts release manifest versions, configured package changelogs,
simple version files, package.json top-level versions, Cargo package versions and
local Cargo.lock package versions, and the exact release-please version line in
`ios/Config/Shared.xcconfig`. Other changes, including mixed code changes outside
iOS, run tests normally. Unrecognized metadata changes also run tests.

The fingerprint covers Git blob contents **and modes** for all tracked iOS files
(except `ios/CHANGELOG.md`), the iOS/proof/release workflows, the CI base resolver,
and release-please configuration. It also includes actual Xcode build version,
device and simulator SDK build versions, architecture, and simulator destination.
Only the values in `ios/version.txt` and the marked `MARKETING_VERSION` line are
normalized for test reuse. The archive fingerprint keeps those values intact.
Consequently an old-version archive never substitutes for a new-version archive.
Dirty or untracked promotion inputs and `Local.xcconfig` are rejected.

Test records preserve repository, builder commit, run ID, and **run attempt**.
Readers consult GitHub's exact run-attempt API and require the iOS workflow's
`build-test` job and actual simulator test step to have succeeded in a main
merge group. They fetch the builder commit when necessary and recompute its
fingerprint; claimed JSON hashes alone are insufficient. Missing test evidence
selects full tests; corrupt evidence, permission errors, or unverifiable
provenance stop the pipeline rather than masquerading as a cache miss.

## Immutable private storage

Unsigned applications and dSYMs use the existing private development artifact
bucket `user-artifact-private-dev`, not the public static bucket. CI and the
consumer use the existing repository `R2_PRIVATE_ARTIFACTS_ACCESS_KEY_ID_DEV` /
`R2_PRIVATE_ARTIFACTS_SECRET_ACCESS_KEY_DEV` secrets and `R2_ACCOUNT_ID` variable.
No new credentials or infrastructure are required. Protect the `okou-ios/`
prefix from independent overwrite or retention cleanup while releases reference
it; deleting an object makes promotion fail closed.

Objects use conditional `PutObject` with `If-None-Match: *`:

```text
okou-ios/tests/<test-input-sha256>/evidence.json
okou-ios/archives/<archive-input-sha256>/<builder-sha>/<run-id>/<attempt>/archive.tar.gz
okou-ios/archives/<archive-input-sha256>/<builder-sha>/<run-id>/<attempt>/manifest.json
okou-ios/inputs/<archive-input-sha256>/ready.json
okou-ios/releases/<release-target-sha>/mapping.json
```

The archive and manifest are uploaded first; readiness is written **last**. Each
builder has a unique namespace, so simultaneous builds cannot combine one run's
archive with another's manifest. The first completed exact-input readiness marker
wins and cannot be overwritten by a later successful run. A losing publisher
verifies the existing complete archive. Test evidence and readiness are separate:
a successful upload does not prove tests passed.

The manifest binds the archive SHA-256, full inputs/toolchain, app version,
builder identity, and exact prior/current test evidence. Readiness binds its
canonical manifest key and manifest SHA-256. Publication can fail if the installed
AWS CLI or R2 does not support conditional writes; there is no unconditional-write
fallback. Repository Actions read permission is required to verify provenance.

## Production consumption and release mapping

`publish-ios-testflight` remains behind the existing **production approval** and
checks out `release-please.outputs.release_target`. Before calling App Store
Connect, it computes that checkout's actual fingerprints, waits up to ten minutes
for the **exact** readiness key, checks provenance and both checksums, and safely
unpacks the device archive. It does not list archives, choose a latest successful
run, or assume the merge-group and main SHAs match.

After verification it writes an immutable `release-target → archive` mapping,
including the original builder SHA/run/attempt, manifest key/hash, archive hash,
and test evidence. A conflicting mapping for the same release target fails.
The same record is retained as a private workflow artifact for 90 days.

The existing App Store Connect preparation obtains the next build number and
internal group. `release-testflight.sh --archive <Original.xcarchive>` copies the
archive and changes only its application/archive Info.plist build numbers. It
imports production distribution material into a disposable keychain and calls
`xcodebuild -exportArchive`, never `archive`, `test`, or package resolution.
Before uploading, it verifies compiled Mach-O sections against the original,
release version/build number, `codesign --verify --deep --strict`, and the expected
team/application distribution entitlements with `get-task-allow` disabled.

Internal-only upload, processing/group availability checks, and private symbol
retention remain unchanged. Signing material and temporary IPA files are deleted
on exit. A missing mapping input, archive, checksum, source identity, toolchain,
or signing verification fails without rebuilding or retesting. Recovery requires
restoring the exact immutable object or fixing the cause, not selecting another
build. Runner-image Xcode/SDK drift between build and consumption also fails
closed and requires matching merge-group inputs to be built again through CI.

## Export-only proof and rollout boundary

`iOS Archive Promotion Proof` remains available for native validation. Its PR job
builds an unsigned device archive and proves metadata-only build-number changes.
On main, an explicit dispatch with `signing_export=true` uses production approval
and calls `--verify-archive`; it verifies distribution export/signing and never
accesses the App Store Connect API or uploads a build. The production script no
longer accepts a no-argument build-and-upload invocation.

The main signing/export prerequisite passed in
[run 37862058239](https://github.com/okou-ai/okou/actions/runs/37862058239) at commit
`3e0f689475709a63a8ed534d11f34e583e8ac3f6`. That proves the local distribution
export path, not App Store Connect acceptance or installation of this pipeline's
first promoted build. The first merge group running this protocol has no
matching evidence, so it runs full tests and seeds the immutable records. No
pre-protocol proof artifacts are eligible for promotion.

## Verification without Apple access

```sh
python3 ios/scripts/archive-promotion.test.py
python3 ios/scripts/archive-proof.test.py
bash ios/scripts/test-ci.sh
node --test ios/scripts/testflight.test.mjs
bash .github/scripts/tests/ios-testflight-workflow-test.sh
```

Promotion tests invoke the real CLI with temporary Git repositories and files;
only external R2/GitHub commands are replaced. They cover differing builder/main
SHAs, metadata-only test reuse, missing evidence/full tests, mixed groups, input
invalidation, independent native-job provenance and input agreement, bounded
queue ancestry, immutable readiness, checksums, missing objects, and safe
extraction. Generated archive placeholders test the protocol, not native
compilation, signing, or TestFlight availability.
