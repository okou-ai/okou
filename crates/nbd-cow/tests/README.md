# nbd-cow native execution

Run `bash crates/nbd-cow/tests/run-nbd-cow-tests.sh` from the repository root with
the exact compiled `TEST_BIN`, `METAL_USER`, `HOST`, numeric `GITHUB_RUN_ID` and
`GITHUB_RUN_ATTEMPT`, and `RUNNER_HOST_GROUP_ID` supplied by the Crates native job.
The authorized metal host must support NBD and sudo. The SSH setup action owns
the transport environment.

Uploads use distinct bounded retry candidates. Native execution is submitted
once, runs the ignored tests serially, preserves its status, and cleans only that
run's candidates. Do not retry a lost execution response as a fresh native test.

`bash crates/nbd-cow/tests/infrastructure/nbd-cow-upload-test.sh` runs the local
upload/false-success/cleanup regressions with controlled external SSH commands.
The existing CI shard registers this owner-relative path; real NBD execution
remains in the native PR job.
