# Pi Bash spool backpressure

The version-pinned `@earendil-works/pi-coding-agent@0.85.1` patch fixes the
local backend used by `createBashTool` in `src/session-runtime.ts`. The runtime
still selects `/usr/local/bin/guest-tool-exec`; its factory and the existing
AgentSession/Photon patch behavior are unchanged.

The original #32637 evidence below was recorded against 0.84.1. The #32641
upgrade ports all six Bash, accumulator and child-process JS/declaration hunks
to official 0.85.1, retaining its shared shell factories, context working
directory and configured spool prefix. The original contract fixtures remain
unchanged and run against the installed 0.85.1 package.

This implements [#32637](https://github.com/vm0-ai/vm0/issues/32637). It does
not establish the cause of the historical termination in
[#32577](https://github.com/vm0-ai/vm0/issues/32577), which remains a separate
investigation. No production replay, stress test, provider request, release,
or production verification is part of this work.

## Flow and lifecycle

`BashOperations.onData` remains synchronous, including consumers whose callback
returns a value that TypeScript discards. The optional `waitForDrain(signal)`
callback lets the local backend wait for the spool using its execution signal.
On a pending wait it pauses **both** stdout and stderr synchronously. There is
one pending wait, with no per-chunk promise chain or auxiliary output queue.

Node's internal `flushStdio()` calls `resume()` on child pipes after exit. The
backend reasserts the shared pause during the `resume` event, before data starts
flowing. The shared `waitForChildProcess` helper has optional cancellation and
consumer-pause inputs. Its existing 100 ms post-exit idle grace cannot destroy
paused unread output; a quiet inherited pipe without consumer backpressure
retains the existing grace and does not hang.

The accumulator keeps the original decoded tail, UTF-8 decoder, counters,
truncation metadata, and update throttle. Its pre-spool raw prefix is at most
`maxBytes`. It flushes that prefix as one bounded write and includes that write
in the spool's `writableNeedDrain` state. Snapshot-created and finish-created
spools use the same path. Successful finalization awaits both file finish and
close. Repeated close is safe.

Sink errors abort the command, including errors between data events. Abort,
caller timeout, open/write failure, and premature close cannot report a
successful partial output file. The caller's existing timeout also owns final
flush; no default timeout is added. Cancellation decodes the accepted display
tail without opening a new spool. It destroys the file stream and uses the
existing process-tree termination path. A kernel filesystem write already in
flight completes asynchronously before Node closes its descriptor; the tool
settles without waiting for that write, and its error listener remains until
close so late I/O errors cannot become unhandled events.

Successful output preserves each pipe's byte order and the observed merged
ingestion order. It does not establish a new chronological order across two
independent OS pipes.

## Signal-terminated tools

The Bash operations contract uses a null exit code for a killed process. The
tool rejects that result after normal output finalization, retaining available
output and reporting `Command terminated by signal`. Native Pi records a failed
tool result and can continue with another tool in the same session. The message
does not identify the specific signal or claim OOM; cancellation and timeout
retain their existing outcomes and take precedence when their owner aborts.

This fixes [#33855](https://github.com/vm0-ai/vm0/issues/33855) without changing
the shared child-process helper, operations types, Guest tool placement, or
memory budgets. Existing per-tool OOM cleanup remains authoritative. The fix
ships with the commit-addressed CLI; already captured contexts keep their older
package. There is no history or API migration and no claim that this explains
the historical run's eventual timeout.

`src/bash-signal.test.ts` drives real Bash children through the installed native
Pi session using a controlled model provider. Both SIGKILL and SIGTERM are
checked through normal prompts and pending-tool continuation: persisted history
must contain a failed result with available output, a successful subsequent Bash
result, and a completed assistant response. These tests do not induce OOM or
replace the separate Guest containment/reuse coverage.

## Audited callers and scope

The original #32637 audit used upstream source at
`earendil-works/pi@53fa77ccd8a279eb87e92294ef3687b03ff80112` and the corresponding
distributed JavaScript runtime, not the TypeScript source.
The patch updates the three affected `.js` files and their `.d.ts` declarations.

- `core/tools/bash.js` is the sole installed `OutputAccumulator` consumer.
- `core/exec.js` also uses `waitForChildProcess`; its existing call without the
  new options remains supported and is exercised through `execCommand`.
- `core/bash-executor.js` / `AgentSession.executeBash` consume
  `createLocalBashOperations` synchronously. Small sanitized output and exit
  behavior are exercised without changing that independent executor.
- Custom operations and the independent interactive/remote executor are not
  converted to paced spooling by this patch. The independent executor retains
  its existing separate spool implementation. The bounded-output guarantee here
  applies to the official local Bash tool used by the runtime factory.

#32637 kept the existing `patchedDependencies` entry and Pi version unchanged.
Its lockfile changed only the coding-agent patch hash and references. `pnpm
patch-commit` generates the patch and hash; unrelated peer-resolution churn is
excluded from this focused change. Applying the original patch to the official
npm tarball and comparing AgentSession JS/declarations and Photon JS confirms
those three files are preserved byte-for-byte.

## Contract fixtures and buffer bound

Run from `turbo/`:

```sh
pnpm -F @okouai/pi-agent-runtime exec vitest run src/bash-spool.test.ts --maxWorkers=1
```

The test launches an isolated Node process for each case. That process imports
the installed official `createBashTool` and uses its real local child-process
backend, without substituting Bash operations or the accumulator. Instrumented
Node built-ins observe the real child pipes and real file `WriteStream`. Only
the filesystem write completion is delayed or gated; writes still reach an
actual temporary file. Error fixtures inject an asynchronous disk error at this
boundary, use a real missing parent directory, or destroy the real stream.
The child-side producer respects its own pipe backpressure.

Each large fixture emits 32 or 64 MiB using unique 64 KiB chunks. Both pipe hashes
are checked against deterministic expected content, and the full output file's
SHA-256 is checked against the observed merged ingestion hash, including size
and successful close. This catches loss, duplication, and per-pipe reordering
without assuming a total order between stdout and stderr.

For these Linux fixtures let `B = 65,536` (maximum admitted chunk and upper bound
on each pipe high-water mark), `H = 65,536` (configured spool high-water mark),
and `P = 51,200` (pre-spool prefix limit). A conservative user-space bound is:

| Component                                       |                                   Bound |
| ----------------------------------------------- | --------------------------------------: |
| Prefix and its single flush copy                |                                    `2P` |
| Writable plus one admitted chunk                |                                 `H + B` |
| Two readable buffers plus one overshoot each    |                                    `4B` |
| Currently delivered chunk                       |                                     `B` |
| Two child write buffers plus one overshoot each |                                    `4B` |
| Total                                           | `2P + 11B = 823,296 bytes`, below 1 MiB |

The fixture samples actual `writableLength`, both actual `readableLength`
values, and the delivered chunk size. It conservatively charges the entire
prefix/copy and child-write allowances even after those buffers are released.
It also checks child-side write peaks, high-water marks, maximum delivered
chunk size, and that at most one drain listener waits. The bound excludes OS
pipe buffers and the separately bounded, unchanged decoded display tail; it is
not an RSS prediction or an exact-RSS assertion.

Observed with Node 24.20.0 and pnpm 10.33.4 in a fresh frozen install:

| Output | MiB | Writable peak | Combined conservative measurement |
| ------ | --: | ------------: | --------------------------------: |
| stdout |  32 |        65,536 |                           495,616 |
| stdout |  64 |        65,536 |                           495,616 |
| stderr |  32 |        65,536 |                           495,616 |
| stderr |  64 |        65,536 |                           495,616 |
| mixed  |  32 |        65,536 |                           561,152 |
| mixed  |  64 |        65,536 |                           561,152 |

Each case has a 20-second internal watchdog and 30-second parent kill deadline.
Paused/final-flush interruption and disk-error settlement, and quiet inherited
stdio have an additional two-second deadline. The post-exit fixture deliberately holds a filesystem write
for 250 ms **after observing child exit**, with unread data remaining, before
releasing it. This is the tested timing boundary, not an arbitrary readiness
sleep. File, child, signal, and drain listeners are inspected after teardown.
The parent also requires a clean child exit and empty stderr, so unhandled
errors/rejections cannot pass silently.

The remaining fixtures cover prefix flush, threshold equality, long-line and
line-count truncation, split UTF-8, empty/small output, live update metadata,
finish-created/snapshot-created spools, repeated close, nonzero exit, real
asynchronous spawn failure, abort/timeout while paused, abort at drain, and
abort/timeout/write error during final flush.

### Negative control and install verification

The original npm tarball was verified against SHA-512 (base64):

```text
ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==
```

Temporarily restoring its three original distributed runtime files makes the
same `slow-32-stdout` contract fail: `Writable pending 33030144 exceeds 131072`.
The patched files are restored after the negative control. This verifies the
real producer regression, not only a manually paced accumulator.

A separate directory with the repository manifests, workspace configuration,
patches, and lockfile and **no `node_modules`** successfully runs:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

All nine installed patched JS/declaration files matched the edited patch package,
Pi remained 0.84.1 in that original verification, and the six large contract
fixtures ran from that fresh installation. Skipping package lifecycle scripts
in this disposable install
does not skip pnpm patch application; the main checkout also passes normal
`pnpm install --frozen-lockfile`.

Additional targeted validation:

```sh
pnpm -F @okouai/pi-agent-runtime exec vitest run src/bash-spool.test.ts src/session-runtime.test.ts src/pending-tool-cancellation.test.ts --maxWorkers=1
pnpm -F @okouai/pi-agent-runtime run lint
pnpm -F @okouai/pi-agent-runtime run check-types
pnpm -F @okouai/pi-agent-runtime run build
pnpm knip --workspace packages/pi-agent-runtime
pnpm exec prettier --check packages/pi-agent-runtime/src/bash-spool.test.ts packages/pi-agent-runtime/src/test-fixtures/bash-spool.mjs packages/pi-agent-runtime/bash-spool-backpressure.md
```

The build includes `check-public-declarations`. An additional TypeScript probe
checks the installed additive declarations, synchronous `onData` return-value
compatibility, and the optional helper/drain arguments. Broader checks belong
to PR CI; no full local Vitest suite or development server is used.
