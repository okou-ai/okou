# Runner profile measurements

The `Runner Profile Benchmark` workflow compares two musl targets and three
explicit overrides of the existing `ci` profile. It builds one immutable CLI
input, materializes committed compiler inputs and reuses `compile.sh`. No
production profile, deployment gate, reusable artifact or remote sccache is
changed. Manual dispatch selects the source revision through the workflow ref.

Each lane prefetches registry sources, starts an empty local disk sccache and
records one cold seed plus three warm trials. Cargo output is deleted at the
same owned path between trials, so warm trials still rebuild/link the binaries.
Reports bind the source, baseline digest, CLI bytes, full profile tables and
overrides, compiler/linker and instrumentation identities to a separate
experiment ID. Only diagnostic JSON and Cargo timing HTML leave the lane.

`guest.json` and `runner.json` record timed command wall time, child CPU and
maximum child RSS, plus available cgroup CPU and memory samples. Child CPU does
not include compilation delegated to the separately running sccache server.
Maximum child RSS is a process high-water mark (including the statistics-reset
child), not aggregate memory. Container memory is sampled every 100ms; it is
not reset kernel `memory.peak`. Unavailable cgroup observations are `null`.
`linker-*.json` observes the existing musl GCC driver, retaining mold/static
arguments. Cargo HTML identifies compiler units and their overlap.

Compare the three individual warm observations and their median/range within
each target after checking identities, host limits and cache statistics. Do not
sum overlapping unit/linker durations or label all runner time as linking:
stable instrumentation does not separately measure frontend, codegen, LTO or
payload work. The cold sample is descriptive, three warm samples do not
establish P95, and this local-cache experiment does not establish production
R2, queue/setup/download or end-to-end required-check improvements. It cannot
justify adopting a profile without the existing runtime/performance gates.
