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
