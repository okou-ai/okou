# Preview resource transport experiment

Read-only investigation for [#43696](https://github.com/okou-ai/okou/issues/43696).
The original preview Worker version and three resource hashes are fixed in
`probe.mjs`; no moving PR alias or user-provided network target is accepted.

## Run

Install the locked `e2e` dependencies and Playwright Chromium headless shell:

```sh
cd e2e
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install --only-shell chromium
cd ..
node --test ops/preview-resource-diagnostics/probe.test.mjs
node ops/preview-resource-diagnostics/probe.mjs /path/to/new-output-directory 1
```

The output directory's parent must exist. Samples 1/3 run HTTP/2 first; samples
2/4 reverse that order. Each sample performs 24 curl GETs: three resources,
static/Worker paths, HTTP/2/HTTP/1.1, and zstd/identity encoding. Transfers have
30-second deadlines and no retries, with at most four curl clients at once.
One additional document GET checks the original build identity without executing it.

Two separate locked Chromium processes fetch the same three resources concurrently
from a locally fulfilled empty document at the original preview origin. Requests
outside the fixed resource set are blocked; credentials are omitted and redirects
are rejected. No application/Clerk scripts execute and no authentication/payment
action is performed. QUIC is disabled for both comparisons; HTTP/2 is additionally
disabled for the HTTP/1.1 comparison. Actual negotiated protocols are recorded.

This is a transport experiment, not deployed sign-in acceptance. Interception
disables browser cache and fetch requests differ from application module loading
in priority/buffering. A healthy result cannot establish the original cause or
prove a login recovery policy. Comparing successful HTTP/1.1 against successful
HTTP/2 does not justify a workaround.

## Evidence and lifecycle

Only `results/` is published, for one day. It contains byte counts, hashes,
timings, allowed response headers, browser progress and sanitized Chromium
NetLogs. Raw headers/bodies are discarded after measurement; raw NetLogs stay
outside that directory and are removed after sanitization. Request headers,
arbitrary URLs, cookies, bodies, descriptions and browser command lines are not
included in the sanitized logs. The remaining NetLog events retain source IDs,
HTTP/2 stream errors and allowlisted numeric transport fields.

Any failed/incomplete transfer, incorrect bytes, unexpected protocol or mismatched
document build makes the experiment fail after the other comparisons complete.
There is no automatic fallback, retry, production configuration change, or change
to existing E2E gates/timeouts.

The PR-only workflow takes four bounded samples on ordinary `ubuntu-latest`
hosts. GitHub chooses their regions; inspect each job's provisioner log and join
it with the artifact's driver revision, runner name, run/attempt and sample.
The samples do not guarantee eastus placement or statistical independence.
Retire this operational experiment when #43696's investigation concludes.
