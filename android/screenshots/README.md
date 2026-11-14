# Feature screenshot acceptance

Run **Android Screenshots** manually with a full `commit_sha` and a repository-relative
`script_path`, for example `android/screenshots/pr-123-feature/run.sh`. Both the app and
recipe come from that commit. The workflow must first be registered on the default branch;
it is also callable by another workflow with the same two inputs.

Each PR uses its own directory, with no shared scenario registry:

```text
android/screenshots/pr-123-feature/
  run.sh
  src/.../ScreenshotScenario.kt
  ... fixture data as needed ...
```

The recipe defines the feature-specific data, native actions, ready-state assertions and
required images. Reuse the existing test-only `TestOkouApplication`, HTTP fixtures and
Activity/UI Automator APIs. These show actual native UI with controlled data; they do not
establish real OAuth/production-backend or physical-device acceptance.

## Recipe contract

The `.sh` entry runs from the repository root. A typical entry is:

```bash
#!/usr/bin/env bash
set -euo pipefail
scenario=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
bash android/scripts/capture-screenshot-scenario.sh "$scenario" list.png history.png
```

Its `src/` tree supplies the test class
`ai.okou.android.screenshots.ScreenshotScenario`. Only the selected directory is added to
`androidTest`, through the manual-only `okou.screenshotScenarioDir` Gradle property. The
adapter selects that class on the existing AGP-managed API35 phone; ordinary tests neither
compile nor discover these feature sources. Shared `androidTest` support is still available.

After observing the intended native UI, call `ScreenshotCapture.capture("list.png")`.
Use bounded native state/visibility assertions, not stabilization sleeps. The helper writes
the PNG and device/configuration metadata into Test Storage before Activity/device teardown.
The adapter requires every declared image from this invocation, rejecting stale, missing,
ambiguous or malformed images. Own and restore fixture state and Activity resources on both
success and failure, as the existing native suites do.

From a clean committed checkout on a Linux/KVM host configured per the Android README:

```bash
python3 android/scripts/screenshots.py run \
  --commit "$(git rev-parse HEAD)" --driver "$(git rev-parse HEAD)" \
  --script android/screenshots/pr-123-feature/run.sh
```

The command replaces only its generated `android/build/screenshots/` output. A failed
recipe or incomplete image bundle returns nonzero; logs and available native diagnostics
remain uploadable. The artifact includes an `index.html`, PNGs, `screenshots.json` with
device details, and `run.json` with actual target SHA, driver SHA and recipe identity.
Download/unzip it and open the index locally. The workflow keeps artifacts for seven days;
download links require the appropriate GitHub access and expire with retention/deletion.

## Before merging

Record the capture run/artifact link and **its source commit SHA** in the PR. Remove this
PR's temporary script, scenario sources and scenario-only data in the same PR before merge.
Keep the shared workflow/runner/support and this convention. The final removal-only commit
is a different revision from the screenshot source; if product behavior changes after the
capture, repeat acceptance before removing the recipe again. Do not leave temporary native
scenarios in the ordinary regression suite or add a production authentication/feature switch.
