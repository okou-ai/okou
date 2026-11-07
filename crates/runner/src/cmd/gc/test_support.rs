use std::path::Path;
use std::time::{Duration, SystemTime};

use runner_host::paths::HomePaths;

use super::GC_MIN_AGE;

pub(super) use runner_host::gc::test_support::{
    assert_is_symlink, old_gc_time, set_soft_nofile_limit_for_child, test_home,
};

pub(super) fn set_mtime(path: &Path, mtime: SystemTime) {
    runner_host::gc::test_support::set_mtime(path, mtime).unwrap();
}

pub(super) fn age_version_past_gc_min_age(home: &HomePaths, name: &str) {
    let old_time = SystemTime::now() - Duration::from_secs(GC_MIN_AGE.as_secs() + 60);
    for path in [
        home.bin_dir().join(name),
        home.bin_dir().join(name).join("runner"),
        home.runners_dir().join(name),
        home.runners_dir().join(name).join("runner.yaml"),
    ] {
        if path.exists() {
            std::fs::File::open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old_time))
                .unwrap();
        }
    }
}
