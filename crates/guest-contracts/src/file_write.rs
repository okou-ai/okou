//! Shared guest file-write budgets.

use std::time::Duration;

use crate::exec_terminal::EXEC_OUTPUT_DRAIN_DEADLINE;

/// Maximum aggregate content in one client-side file batch, leaving room for
/// paths and framing below the protocol's maximum message size.
/// Larger private inputs retain the existing individual/chunked write path.
pub const WRITE_FILES_BATCH_CONTENT_LIMIT: usize = 15 * 1024 * 1024;

/// Maximum number of files admitted by the private/ordinary batch client.
pub const WRITE_FILES_BATCH_FILE_LIMIT: usize = 64;

/// Maximum time the guest waits for its file-write helper process.
pub const WRITE_FILE_HELPER_TIMEOUT_MS: u32 = 30_000;

// Duration form of `WRITE_FILE_HELPER_TIMEOUT_MS` for budget composition.
const WRITE_FILE_HELPER_TIMEOUT: Duration =
    Duration::from_millis(WRITE_FILE_HELPER_TIMEOUT_MS as u64);

/// Maximum time the guest spends writing one terminal protocol frame.
///
/// File-write results share the connection writer with every other guest
/// response, so this remains a connection-wide frame deadline.
pub const GUEST_FRAME_WRITE_DEADLINE: Duration = Duration::from_secs(10);

// Host-side allowance for request-frame construction, transmission, guest
// dispatch, and scheduling beyond the guest's configured processing budgets.
const WRITE_FILE_TRANSPORT_HEADROOM: Duration = Duration::from_secs(15);

const WRITE_FILE_CONFIGURED_GUEST_BUDGET: Duration = WRITE_FILE_HELPER_TIMEOUT
    .saturating_add(EXEC_OUTPUT_DRAIN_DEADLINE)
    .saturating_add(GUEST_FRAME_WRITE_DEADLINE);

/// End-to-end host deadline for one file-write request frame and its terminal
/// response.
pub const WRITE_FILE_REQUEST_DEADLINE: Duration =
    WRITE_FILE_CONFIGURED_GUEST_BUDGET.saturating_add(WRITE_FILE_TRANSPORT_HEADROOM);
