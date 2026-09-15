//! Limits for runner-side object downloads.

use std::time::Duration;

/// Maximum time allowed for one bounded object-download request.
pub(crate) const OBJECT_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
