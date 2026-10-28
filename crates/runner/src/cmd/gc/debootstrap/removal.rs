// Each accepted unlink owns the acquired cache authority until physical retirement.
pub(super) use runner_host::gc::remove_file_with_lock as remove_cache_file;

#[cfg(test)]
mod tests;
