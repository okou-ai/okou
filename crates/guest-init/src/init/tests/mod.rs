use super::*;
use std::os::fd::AsRawFd;

#[test]
fn file_descriptor_link_exposes_current_process_descriptors() {
    let dev_dir = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new().unwrap();
    fs::write(file.path(), "descriptor contents\n").unwrap();

    create_file_descriptor_link(dev_dir.path()).unwrap();

    let link = dev_dir.path().join("fd");
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("/proc/self/fd"));
    let descriptor = link.join(file.as_file().as_raw_fd().to_string());
    assert_eq!(
        fs::read_to_string(descriptor).unwrap(),
        "descriptor contents\n"
    );
}

#[test]
fn file_descriptor_link_rejects_existing_entries() {
    let dev_dir = tempfile::tempdir().unwrap();
    let path = dev_dir.path().join("fd");
    fs::write(&path, "existing entry").unwrap();

    let error = create_file_descriptor_link(dev_dir.path()).unwrap_err();

    assert!(matches!(
        error,
        InitError::Filesystem { path: error_path, source, .. }
            if error_path == path.display().to_string()
                && source.kind() == io::ErrorKind::AlreadyExists
    ));
    assert_eq!(fs::read_to_string(path).unwrap(), "existing entry");
}

fn write_cgroup_core_files(base: &Path, subtree_control: &str) {
    fs::create_dir_all(base).unwrap();
    for (filename, content) in [
        (CGROUP_CONTROLLERS_FILE, "cpu memory pids\n"),
        (CGROUP_PROCS_FILE, ""),
        (CGROUP_EVENTS_FILE, "populated 0\nfrozen 0\n"),
        (CGROUP_KILL_FILE, ""),
        (CGROUP_SUBTREE_CONTROL_FILE, subtree_control),
        (CPU_WEIGHT_FILE, "100\n"),
        (PIDS_MAX_FILE, "max\n"),
    ] {
        fs::write(base.join(filename), content).unwrap();
    }
    fs::write(
        base.join(MEMORY_MIN_FILE),
        AGENT_MEMORY_MIN_BYTES.to_string(),
    )
    .unwrap();
}

#[test]
fn parse_env_basic() {
    let content = "LANG=en_US.UTF-8\nPATH=/usr/bin:/bin";
    let pairs = parse_env_content(content);
    assert_eq!(
        pairs,
        vec![("LANG", "en_US.UTF-8"), ("PATH", "/usr/bin:/bin")]
    );
}

#[test]
fn parse_env_quoted_values() {
    let content = r#"FOO="bar baz""#;
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("FOO", "bar baz")]);
}

#[test]
fn parse_env_skips_comments_and_blanks() {
    let content = "# comment\n\nKEY=value\n  \n# another comment\n";
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("KEY", "value")]);
}

#[test]
fn parse_env_skips_lines_without_equals() {
    let content = "no_equals_sign\nGOOD=yes";
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("GOOD", "yes")]);
}

#[test]
fn parse_env_trims_whitespace() {
    let content = "  KEY  =  value  ";
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("KEY", "value")]);
}

#[test]
fn parse_env_empty_value() {
    let content = "EMPTY=";
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("EMPTY", "")]);
}

#[test]
fn parse_env_value_with_equals() {
    // Values may legitimately contain `=`; only the first one separates key/value.
    let content = "TOKEN=abc=def==";
    let pairs = parse_env_content(content);
    assert_eq!(pairs, vec![("TOKEN", "abc=def==")]);
}

#[test]
fn parse_env_empty_key_skipped() {
    let content = "=value";
    let pairs = parse_env_content(content);
    assert!(pairs.is_empty());
}

#[test]
fn init_error_display() {
    let err = InitError::Mount {
        target: "/proc".into(),
        source: nix::Error::EACCES,
    };
    let msg = err.to_string();
    assert!(msg.contains("/proc"));
    assert!(msg.contains("EACCES"));
}

#[test]
fn process_containment_base_requires_core_files() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "");
    fs::remove_file(dir.path().join(CGROUP_KILL_FILE)).unwrap();

    let error = verify_process_containment_base(dir.path()).unwrap_err();

    assert!(error.to_string().contains(CGROUP_KILL_FILE));
}

#[test]
fn process_containment_base_rejects_missing_controller() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "cpu memory\n");

    let error = verify_process_containment_base(dir.path()).unwrap_err();

    assert!(error.to_string().contains("pids"));
}

#[test]
fn process_containment_base_accepts_required_controllers() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "cpu memory pids\n");

    verify_process_containment_base(dir.path()).unwrap();
}

#[test]
fn process_containment_base_rejects_direct_processes() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "cpu memory pids\n");
    fs::write(dir.path().join(CGROUP_PROCS_FILE), "123\n").unwrap();

    let error = verify_process_containment_base(dir.path()).unwrap_err();

    assert!(error.to_string().contains("direct processes"));
}

#[test]
fn process_containment_base_rejects_missing_ancestor_memory_protection() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "cpu memory pids\n");
    fs::write(dir.path().join(MEMORY_MIN_FILE), "0\n").unwrap();

    let error = verify_process_containment_base(dir.path()).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("preserve control and runtime memory")
    );
}

#[test]
fn process_containment_base_rejects_previous_control_only_protection() {
    let dir = tempfile::tempdir().unwrap();
    write_cgroup_core_files(dir.path(), "cpu memory pids\n");
    fs::write(
        dir.path().join(MEMORY_MIN_FILE),
        (384 * 1024 * 1024).to_string(),
    )
    .unwrap();

    assert!(verify_process_containment_base(dir.path()).is_err());
}
