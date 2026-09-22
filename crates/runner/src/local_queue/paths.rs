//! Shared filesystem layout for `runner local` file queues.

use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};
use runner_types::ids::RunId;

fn profile_segments(profile: &str) -> RunnerResult<(&str, &str)> {
    crate::profile::validate_or_err(profile)?;
    profile
        .split_once('/')
        .ok_or_else(|| RunnerError::Config(format!("invalid profile name: {profile}")))
}

pub(crate) fn jobs_dir(group_dir: &Path) -> PathBuf {
    group_dir.join("jobs")
}

pub(crate) fn profile_jobs_dir(group_dir: &Path, profile: &str) -> RunnerResult<PathBuf> {
    let (org, name) = profile_segments(profile)?;
    Ok(jobs_dir(group_dir).join(org).join(name))
}

pub(crate) fn job_path(group_dir: &Path, profile: &str, run_id: RunId) -> RunnerResult<PathBuf> {
    Ok(profile_jobs_dir(group_dir, profile)?.join(format!("{run_id}.job")))
}

pub(crate) fn claims_dir(group_dir: &Path) -> PathBuf {
    group_dir.join("claims")
}

pub(crate) fn claim_path(group_dir: &Path, run_id: RunId) -> PathBuf {
    claims_dir(group_dir).join(format!("{run_id}.claim"))
}

pub(crate) fn results_dir(group_dir: &Path) -> PathBuf {
    group_dir.join("results")
}

pub(crate) fn result_path(group_dir: &Path, run_id: RunId) -> PathBuf {
    results_dir(group_dir).join(format!("{run_id}.result"))
}

pub(crate) fn cancels_dir(group_dir: &Path) -> PathBuf {
    group_dir.join("cancels")
}

pub(crate) fn cancel_path(group_dir: &Path, run_id: RunId) -> PathBuf {
    cancels_dir(group_dir).join(format!("{run_id}.cancel"))
}

pub(crate) fn inputs_dir(group_dir: &Path) -> PathBuf {
    group_dir.join("inputs")
}

pub(crate) fn run_inputs_dir(group_dir: &Path, run_id: RunId) -> PathBuf {
    inputs_dir(group_dir).join(run_id.to_string())
}

pub(crate) fn active_input_path(group_dir: &Path, run_id: RunId, sequence: u64) -> PathBuf {
    run_inputs_dir(group_dir, run_id).join(format!("{sequence:020}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_paths_split_validated_profile() {
        let root = Path::new("/queue");
        let path = job_path(root, "vm0/default", RunId::from(uuid::Uuid::nil())).unwrap();
        assert_eq!(
            path,
            PathBuf::from(format!(
                "/queue/jobs/vm0/default/{}.job",
                RunId::from(uuid::Uuid::nil())
            ))
        );
    }

    #[test]
    fn profile_paths_reject_invalid_profile() {
        let root = Path::new("/queue");
        let err = profile_jobs_dir(root, "../etc/passwd").unwrap_err();
        assert!(err.to_string().contains("invalid profile name"));
    }
}
