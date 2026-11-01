mod dm_snapshot;
mod nbd_cow;

pub(crate) use dm_snapshot::run_dm_snapshot_bench;
pub(crate) use nbd_cow::run_nbd_cow_bench;

fn result_after_cleanup<T>(
    result: Result<T, String>,
    cleanup_errors: Vec<String>,
) -> Result<T, String> {
    if cleanup_errors.is_empty() {
        return result;
    }

    let cleanup_message = cleanup_errors.join("; ");
    match result {
        Ok(_) => Err(format!("cleanup failed: {cleanup_message}")),
        Err(err) => Err(format!("{err}; cleanup also failed: {cleanup_message}")),
    }
}

#[cfg(test)]
mod tests;
