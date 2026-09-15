//! Mock Claude CLI for testing.
//!
//! Executes the prompt as a bash command and outputs Claude-compatible JSONL.
//! This is the Rust equivalent of `mock-claude.ts` for Firecracker VMs.
//!
//! Usage: `claude-mock [options] <prompt>`
//!
//! Special test prefixes:
//!
//! ```text
//!   @fail:<message>           - Output message to stderr and exit with code 1
//!   @fail-no-newline:<message>
//!                             - Output message to stderr without a trailing
//!                               newline and exit with code 1
//!   @fail-invalid-utf8        - Output invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @fail-invalid-utf8-long   - Output many invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @stdout-over-limit-no-newline
//!                             - Stream an oversized stdout record, then hang
//!   @stdout-over-limit-newline
//!                             - Stream an oversized LF record, then hang
//!   @stdout-invalid-utf8      - Emit invalid stdout UTF-8, then hang
//!   @stdout-record-boundaries - Emit exact-limit, CRLF, and EOF stdout records
//!   @stuck-tool               - Emit WebFetch tool_use then hang (test stuck-tool watchdog)
//!   @stuck-tool-deaf          - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it
//!   @stuck-tool-closed-stdout-deaf
//!                             - Same, but closes stdout before hanging
//!   @orphan-pipe              - Emit events, spawn child holding stdout, then exit
//!   @hang-after-result        - Emit result event, then hang the process
//!                               (SIGTERM kills it -> exits with 143; tests
//!                               the SigtermPending->Done reap path)
//!   @hang-after-result-deaf   - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it; tests the
//!                               SigkillPending->Done escalation path
//!   @hang-after-result-then-event
//!                             - Emit result, then one release-gated meaningful
//!                               event, then hang
//!   @hang-after-result-periodic-events
//!                             - Emit result, then two release-gated meaningful
//!                               events, then hang
//!   @hang-after-error-result  - Emit an error result, then hang
//!   @exit-after-result        - Emit result event, exit(0) immediately;
//!                               tests that reap stays no-op on the
//!                               happy path
//!   @write-env-json:<path>    - Write current process env as JSON to path,
//!                               emit result, and exit(0)
//!   @append-prompt-transport:<json>
//!                             - Capture argv and verify file-backed appended
//!                               prompt transport plus broad pkill isolation
//!   @parallel-shell-tool-oom  - Run two Bash tools concurrently and verify
//!                               a group OOM leaves the unrelated tool alive
//!   @guest-wide-tool-oom      - Verify tool priority under isolated Guest-wide OOM
//!   @runtime-only-oom         - Exhaust the managed runtime with no eligible tools
//!   @ECHO@                    - First-line marker. Validate remaining non-empty
//!                               lines as JSONL and emit them unchanged.
//!   @ECHO-HANG@               - Same as @ECHO@, then remain alive until reaped.
//!   @active-input-smoke:<n>   - Stream-json stdin marker. Emit a first result,
//!                               then read n later user frames from the same
//!                               stdin stream and emit a deterministic final result.
//!   @active-input-smoke-ready:<n>
//!                             - Stream-json stdin marker. Read and buffer the
//!                               first follow-up before emitting the readiness
//!                               result, then consume the remaining frames.
//! ```

mod args;
mod process;
mod scenario;
mod transcript;

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = args::parse_args(&args);

    process::run(parsed)
}
