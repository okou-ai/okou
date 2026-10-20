//! Shared filesystem accounting and identity-aware lock cleanup for host GC.

mod filesystem;
mod lock_file;
pub mod workspaces;

pub use filesystem::{
    DirStats, GcDirEntryReader, GcDirStatus, collect_dir_stats, dir_stats, gc_entry_is_real_dir,
    gc_path_dir_status, next_entry_warn_or_stop, read_dir_or_missing,
};
pub use lock_file::{
    ExistingLockProbe, LockProbe, probe_existing_lock, probe_lock, remove_unused_lock_after_probe,
};

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
