# Internal TestFlight releases

Okou iOS participates in the existing release-please manifest as `ios`. A release
PR updates `ios/version.txt`, `Config/Shared.xcconfig`, the release manifest, and
its changelog. The initial managed release is `0.1.1`. Merging that PR creates `ios-v<VERSION>` and runs
`publish-ios-testflight` in `.github/workflows/release-please.yml`.

Like Desktop, publication uses GitHub-hosted macOS and the existing `production`
environment approval. No local Mac, Apple account password, external beta review,
or App Store release submission is part of routine publication. The release job
checks out the exact release target, uses locked Swift packages, signs a device
archive, exports an **internal-only** IPA, and uploads it to App Store Connect.
An internal-only build cannot later be used for external testing or an App Store
release; that would require a new build and a deliberate export-policy change.

## One-time setup

In the Max & Zoe, Inc. team (`C5UWSXYB67`):

1. Confirm the explicit `ai.okou.ios` identifier and create its iOS App Store
   Connect record if necessary. Resolve any pending developer agreements with
   the Account Holder.
2. Create an internal group (for example, `Internal`), add at least one eligible
   App Store Connect user, and have testers accept their invitations. The job
   assigns each processed build to this group; automatic distribution may also
   be enabled in App Store Connect.
3. Provision an **Apple Distribution** certificate and its private key, plus an
   **App Store Connect** distribution profile for `ai.okou.ios`. The Desktop
   Developer ID Application certificate is not suitable for iOS. Store the
   following secrets in GitHub's existing `production` environment:

   | Secret                            | Value                                                   |
   | --------------------------------- | ------------------------------------------------------- |
   | `IOS_DISTRIBUTION_P12_BASE64`     | Base64 of the distribution identity exported as PKCS#12 |
   | `IOS_DISTRIBUTION_P12_PASSWORD`   | Password protecting that export                         |
   | `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the distribution provisioning profile         |

4. Set the production environment variable `IOS_INTERNAL_GROUP_NAME` to the exact
   internal group name.
5. Create a dedicated team API key with the **App Manager** role for iOS and
   store it in the same production environment:

   | Secret                                 | Value                                      |
   | -------------------------------------- | ------------------------------------------ |
   | `IOS_APP_STORE_CONNECT_API_KEY_BASE64` | Base64 of the downloaded `.p8` private key |
   | `IOS_APP_STORE_CONNECT_API_KEY_ID`     | Key ID shown in App Store Connect          |
   | `IOS_APP_STORE_CONNECT_API_ISSUER_ID`  | Team issuer ID shown in App Store Connect  |

   Verify it can access this app, upload builds, and manage internal build/group
   relationships. Keep Desktop's existing `APP_STORE_CONNECT_API_*` credentials
   unchanged: its Developer-role notarization key does not provide the App
   Manager permission required to assign builds to testing groups. API private
   keys can only be downloaded once; retain a secure backup and never log them.

The repository declares `ITSAppUsesNonExemptEncryption=false`: the app's
networking uses OS TLS, Clerk uses system Security/CryptoKit, and Ably's optional
cipher implementation uses system CommonCrypto. Re-evaluate the declaration if
adding custom encryption or changing these dependencies. Clerk, Ably, and
PhoneNumberKit carry their own privacy manifests; Xcode upload validation remains
required for the final archive.

## Versioning, validation, and failure recovery

- The visible version comes from release-please. The build number is the next
  integer above all builds of this app in App Store Connect, including failed
  builds. The existing production deployment queue serializes releases. Do not
  run another independent uploader concurrently; the API does not reserve build
  numbers. The workflow fails rather than guessing if existing build numbers use
  another scheme or reach 9999.
- Release PR updates made with `GITHUB_TOKEN` do not trigger `pull_request` CI.
  When iOS inputs change, the release refresh explicitly dispatches the real iOS
  workflow on the release branch. It does not manufacture a passing iOS check.
  Merge-group validation continues to run normally.
- Upload completion is not publication completion. The job waits up to 30 minutes
  for the exact app/version/build to finish processing, assigns it only to the
  configured internal group, and reads back both group membership and the
  `IN_BETA_TESTING` state. Missing export compliance, invalid builds, API access
  errors, and timeouts fail the job. This is API evidence of availability; verify
  installation and login on a tester's iPhone for the first release.
- On failure, inspect the publishing job and App Store Connect. Re-run the failed
  publishing job after resolving the cause; it allocates a new build number for
  the same release source. Re-running the whole release-please workflow may no
  longer report a newly created release, so prefer **Re-run failed jobs**. Never
  change a published release tag to recover a failed upload.
- dSYMs are retained as private workflow artifacts for 90 days. Signing material
  lives in a temporary keychain and temporary files and is removed when the
  publishing script exits. Renew the certificate/profile before expiration.
- The existing server rollback workflow does not roll back installed iOS apps.
  Ship a corrected build instead. A separate minimum-build API gate remains
  outstanding; TestFlight's 90-day build validity is not that gate.

## Local verification without Apple access

```sh
node --test ios/scripts/testflight.test.mjs
bash .github/scripts/tests/ios-testflight-workflow-test.sh
```

The HTTP tests use a real loopback server and generated test signing keys. They
cover JWT verification, pagination, internal-only enforcement, build selection,
processing, persistent group assignment, access errors, and timeout behavior.
They do not upload an app, read production data, or replace a signed CI archive
and TestFlight installation check.
