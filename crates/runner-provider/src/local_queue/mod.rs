//! Shared local file-queue protocol for `runner local` commands and provider.

mod fs;
mod paths;
mod state;
mod types;

pub use fs::{
    create_private_marker, ensure_cancels_dir, ensure_claims_dir, ensure_group_dir,
    ensure_profile_jobs_dir, ensure_results_dir, ensure_run_inputs_dir, marker_file_exists,
    marker_path_occupied, open_private_new_file, private_file_has_content, read_private_file,
    read_private_file_with_max, validate_cancels_dir, validate_claims_dir, validate_group_dir,
    validate_inputs_dir, validate_results_dir, validate_run_inputs_dir, write_private_file,
    write_private_marker,
};
pub use paths::{
    active_input_path, cancel_path, cancels_dir, claim_path, claims_dir, inputs_dir, job_path,
    jobs_dir, profile_jobs_dir, result_path, results_dir, run_inputs_dir,
};
pub use state::{CancelTargetState, LocalClaimResult, LocalDiscoveredJob, LocalQueue};
pub use types::{ActiveInputEntry, JobRequest, JobResponse};

/// Maximum byte length of one complete serialized local [`JobRequest`].
///
/// Submit, discovery, and claim share this limit so independently deployed
/// producers and consumers enforce the same local queue resource boundary.
pub const LOCAL_JOB_MAX_BYTES: usize = 16 * 1024 * 1024;
