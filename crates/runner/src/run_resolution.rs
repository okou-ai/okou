//! Resolve user-supplied run ids through live runner registry and status state.

use std::path::Path;

use crate::error::{RunnerError, RunnerResult};
use crate::live_runner_instances::LiveRunnerInstance;
use crate::status_file::{self, StatusActiveRunsOnly, StatusFileReadError};
use runner_host::paths::HomePaths;

/// Read `{base_dir}/status.json` and extract `(run_id, sandbox_id)` for
/// every active run. Returns `None` if the file is missing or unparseable
/// (logs at `warn` level so the operator sees the miss immediately).
async fn read_active_runs(base_dir: &Path) -> Option<Vec<(String, String)>> {
    let status = match status_file::read_as::<StatusActiveRunsOnly>(base_dir).await {
        Ok(Some(status)) => status,
        Ok(None) => {
            let path = status_file::path(base_dir);
            tracing::warn!(path = %path.display(), "skipping runner: status.json is missing");
            return None;
        }
        Err(StatusFileReadError::Read { path, error }) => {
            tracing::warn!(path = %path.display(), error = %error, "skipping runner: cannot read status.json");
            return None;
        }
        Err(StatusFileReadError::ParseJson { path, error }) => {
            tracing::warn!(path = %path.display(), error = %error, "skipping runner: cannot parse status.json");
            return None;
        }
    };
    Some(
        status
            .active_runs
            .into_iter()
            .map(|run| (run.run_id, run.sandbox_id))
            .collect(),
    )
}

/// Result of collecting `(run_id, sandbox_id)` pairs from runners.
pub(crate) struct ActiveRunMappings {
    pub entries: Vec<(String, String)>,
    /// How many trusted live runner registry entries were scanned.
    pub runners_total: usize,
    /// How many trusted live runner status files were unreadable.
    pub runners_failed: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedRunMapping {
    pub run_id: String,
    pub sandbox_id: String,
}

/// Collect all `(run_id, sandbox_id)` pairs from every reachable runner's
/// `status.json`. Used by `kill --run` and `exec --run` to translate a
/// user-supplied run_id into the sandbox_id that identifies the FC.
pub(crate) async fn collect_active_run_mappings(
    runners: &[LiveRunnerInstance],
) -> ActiveRunMappings {
    let mut entries = Vec::new();
    let mut failed = 0usize;
    let mut scanned = 0usize;
    for runner in runners {
        if runner.subcommand != "start" {
            continue;
        }
        scanned += 1;
        match read_active_runs(&runner.base_dir).await {
            Some(runs) => entries.extend(runs),
            None => failed += 1,
        }
    }
    ActiveRunMappings {
        entries,
        runners_total: scanned,
        runners_failed: failed,
    }
}

/// Collect active run mappings from the validated live runner registry.
pub(crate) async fn collect_active_run_mappings_from_home(
    home: &HomePaths,
) -> RunnerResult<ActiveRunMappings> {
    let runners = crate::live_runner_instances::try_list(home).await?;
    Ok(collect_active_run_mappings(&runners).await)
}

/// Given a full `run_id` or prefix, find the matching active run from collected
/// status entries.
///
/// A unique exact match is accepted even when some trusted live runner status
/// files were unreadable. A non-exact prefix is accepted only when it uniquely
/// identifies a collected mapping and every trusted live runner status file was
/// readable.
///
/// Returns an error for empty input, no matches, ambiguous matches, or a
/// non-exact match when the runner-status scan was incomplete.
/// When no match is found and some runners were unreadable, the error
/// message includes a diagnostic hint so the operator knows why.
pub(crate) fn resolve_run_mapping(
    input: &str,
    mappings: &ActiveRunMappings,
) -> RunnerResult<ResolvedRunMapping> {
    if input.is_empty() {
        return Err(RunnerError::Config("run id must not be empty".into()));
    }

    let mut matching: Vec<&(String, String)> = mappings
        .entries
        .iter()
        .filter(|(rid, _)| rid.starts_with(input))
        .collect();
    matching.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    matching.dedup();

    match matching.as_slice() {
        [(run_id, sandbox_id)] => {
            if mappings.runners_failed > 0 && run_id.as_str() != input {
                return Err(RunnerError::Config(format!(
                    "run prefix '{input}' matched run '{run_id}', but {} of {} trusted live runner status file(s) were unreadable; use the full run id or retry after checking warnings above",
                    mappings.runners_failed, mappings.runners_total,
                )));
            }
            Ok(ResolvedRunMapping {
                run_id: (*run_id).clone(),
                sandbox_id: (*sandbox_id).clone(),
            })
        }
        [] => {
            let mut msg = format!("no active run matches '{input}'");
            if mappings.runners_failed > 0 {
                msg.push_str(&format!(
                    " ({} of {} trusted live runner status file(s) were unreadable — \
                     check warnings above)",
                    mappings.runners_failed, mappings.runners_total,
                ));
            } else if mappings.runners_total == 0 {
                msg.push_str(" (no trusted live runner status found on this host)");
            }
            Err(RunnerError::Config(msg))
        }
        _ => {
            let lines: Vec<String> = matching
                .iter()
                .map(|(rid, sid)| format!("run={rid} sandbox={sid}"))
                .collect();
            Err(RunnerError::Config(format!(
                "ambiguous run prefix '{input}', matches: [{}]",
                lines.join(", ")
            )))
        }
    }
}

/// Resolve a full `run_id` or prefix to a `sandbox_id` using the same exact-ID,
/// prefix-uniqueness, and incomplete-scan rules as [`resolve_run_mapping`].
#[cfg(test)]
pub(crate) fn resolve_run_to_sandbox(
    input: &str,
    mappings: &ActiveRunMappings,
) -> RunnerResult<String> {
    Ok(resolve_run_mapping(input, mappings)?.sandbox_id)
}

#[cfg(test)]
mod tests;
