use std::path::Path;
use std::time::SystemTime;

pub(super) use runner_host::gc::test_support::{
    assert_is_symlink, old_gc_time, set_soft_nofile_limit_for_child, test_home,
};

pub(super) fn set_mtime(path: &Path, mtime: SystemTime) {
    runner_host::gc::test_support::set_mtime(path, mtime).unwrap();
}
