#[cfg(test)]
pub use runner_host::test_fixtures::ignored_child;

pub fn home_image_cache_key(reuse_key: &str) -> String {
    runner_host::paths::scoped_home_image_cache_key("", "vm0/default", reuse_key, 1024 * 1024)
}

pub fn runner_home_image_cache_dir(paths: &runner_host::paths::RunnerPaths) -> std::path::PathBuf {
    paths.base_dir().join("home-image-cache")
}
