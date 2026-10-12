use std::fs;
use std::io;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use api_contracts::generated::constants::runners::paths::CANONICAL_CODEX_HOME_DIR;
use shell_quote::quote_shell_arg;

const CODEX_SESSION_CLEANUP_SCRIPT: &str = include_str!("../../scripts/codex-session-cleanup.sh");

fn codex_session_cleanup_command(codex_home: &str) -> String {
    let codex_home = quote_shell_arg(codex_home);
    format!("codex_home={codex_home}\n{CODEX_SESSION_CLEANUP_SCRIPT}")
}

const SESSION_ID: &str = "019e9154-c304-70f0-adde-36efb1be1701";
const SESSION_ID_NO_DASHES: &str = "019e9154c30470f0adde36efb1be1701";

fn restore_path(codex_home: &Path) -> PathBuf {
    codex_home.join(format!(
        "sessions/2026/06/04/rollout-2026-06-04T07-18-08-{SESSION_ID}.jsonl"
    ))
}

fn create_file(path: &Path) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("test path should have a parent: {}", path.display()),
        )
    })?;
    fs::create_dir_all(parent)?;
    fs::write(path, "test")
}

fn canonical_path(codex_home: &Path, date: &str, time: &str) -> PathBuf {
    let date_components: Vec<_> = date.split('-').collect();
    let [year, month, day] = date_components.as_slice() else {
        assert_eq!(date_components.len(), 3, "test date should be YYYY-MM-DD");
        return codex_home.to_path_buf();
    };
    codex_home.join(format!(
        "sessions/{year}/{month}/{day}/rollout-{date}T{time}-{SESSION_ID}.jsonl"
    ))
}

fn run_cleanup(codex_home: &Path, restore_path: &Path) -> io::Result<Output> {
    run_cleanup_with_session_id(codex_home, restore_path, SESSION_ID)
}

fn run_cleanup_with_session_id(
    codex_home: &Path,
    restore_path: &Path,
    session_id: &str,
) -> io::Result<Output> {
    let session_filename_key = session_id.replace('-', "");
    run_cleanup_with_session_identity(codex_home, restore_path, session_id, &session_filename_key)
}

fn run_cleanup_with_session_identity(
    codex_home: &Path,
    restore_path: &Path,
    session_id: &str,
    session_filename_key: &str,
) -> io::Result<Output> {
    cleanup_command(codex_home, restore_path, session_id, session_filename_key).output()
}

fn run_cleanup_with_budget(
    codex_home: &Path,
    restore_path: &Path,
    budget: &str,
) -> io::Result<Output> {
    cleanup_command(codex_home, restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
        .env("OKOU_CODEX_SESSION_CLEANUP_SCAN_BUDGET", budget)
        .output()
}

fn cleanup_command(
    codex_home: &Path,
    restore_path: &Path,
    session_id: &str,
    session_filename_key: &str,
) -> Command {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(codex_session_cleanup_command(
            codex_home.to_string_lossy().as_ref(),
        ))
        .env("OKOU_CODEX_RESTORE_SESSION_ID", session_id)
        .env(
            "OKOU_CODEX_RESTORE_SESSION_FILENAME_KEY",
            session_filename_key,
        )
        .env("OKOU_CODEX_RESTORE_SESSION_PATH", restore_path);
    command
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
}

fn assert_failure_contains(output: &Output, expected: &str) {
    assert!(
        !output.status.success(),
        "expected command to fail; stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains(expected),
        "expected stderr to contain {expected:?}, got {stderr:?}"
    );
}

#[test]
fn cleanup_command_uses_fixed_codex_home_prelude() {
    let command = codex_session_cleanup_command(CANONICAL_CODEX_HOME_DIR);

    assert!(command.contains("codex_home='/home/user/.codex'"));
    assert!(command.contains("root=\"$codex_home/sessions\""));
    assert!(command.contains("scan_budget="));
    assert!(command.contains("collect_matching_session_entries"));
    assert!(command.contains("find \"$root\" -mindepth 1 -printf '%y%p\\0'"));
    assert!(command.contains("canonical_logical_path"));
    assert!(command.contains("candidate_ambiguous"));
    assert!(command.contains("delete_matching_session_entries"));
    assert!(command.contains("xargs -0"));
    assert!(!command.contains("-delete"));
    assert!(!command.contains("for path in \"$dir\"/*"));
}

#[test]
fn cleanup_script_deletes_matching_session_files_and_symlinks() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();

    let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
    let matching_zst = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl.zst"));
    let matching_tmp = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl.vm0tmp-123"));
    let matching_no_dash = codex_home.join("sessions/2026/06/05").join(format!(
        "rollout-b-{SESSION_ID_NO_DASHES}.jsonl.zst.vm0tmp-456"
    ));
    let matching_newline = restore_dir.join(format!("rollout-line\nbreak-{SESSION_ID}.jsonl"));
    let matching_non_layout = codex_home
        .join("sessions/not-layout/deep")
        .join(format!("rollout-c-{SESSION_ID}.jsonl"));
    let matching_symlink = restore_dir.join(format!("rollout-link-{SESSION_ID}.jsonl"));
    let matching_directory = restore_dir.join(format!("rollout-dir-{SESSION_ID}.jsonl"));
    let unrelated = restore_dir.join("rollout-other-session.jsonl");

    create_file(&matching_jsonl).unwrap();
    create_file(&matching_zst).unwrap();
    create_file(&matching_tmp).unwrap();
    create_file(&matching_no_dash).unwrap();
    create_file(&matching_newline).unwrap();
    create_file(&matching_non_layout).unwrap();
    create_file(&unrelated).unwrap();
    fs::create_dir(&matching_directory).unwrap();
    symlink(&unrelated, &matching_symlink).unwrap();

    let output = run_cleanup(&codex_home, &restore_path).unwrap();

    assert_success(&output);
    assert!(output.stdout.is_empty());
    assert!(!matching_jsonl.exists());
    assert!(!matching_zst.exists());
    assert!(!matching_tmp.exists());
    assert!(!matching_no_dash.exists());
    assert!(!matching_newline.exists());
    assert!(!matching_non_layout.exists());
    assert!(!matching_symlink.exists());
    assert!(matching_directory.exists());
    assert!(unrelated.exists());
}

#[test]
fn cleanup_script_returns_existing_canonical_logical_path() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let existing_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    create_file(&existing_path).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", existing_path.display())
    );
    assert!(!existing_path.exists());
}

#[test]
fn cleanup_script_normalizes_existing_zstd_path_to_logical_path() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let logical_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    let compressed_path = PathBuf::from(format!("{}.zst", logical_path.display()));
    create_file(&compressed_path).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", logical_path.display())
    );
    assert!(!compressed_path.exists());
}

#[test]
fn cleanup_script_treats_raw_and_zstd_siblings_as_one_logical_path() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let logical_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    let compressed_path = PathBuf::from(format!("{}.zst", logical_path.display()));
    create_file(&logical_path).unwrap();
    create_file(&compressed_path).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", logical_path.display())
    );
    assert!(!logical_path.exists());
    assert!(!compressed_path.exists());
}

#[test]
fn cleanup_script_rejects_distinct_canonical_paths_without_deleting_them() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let first_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    let second_path = canonical_path(&codex_home, "2026-07-24", "05-02-05");
    create_file(&first_path).unwrap();
    create_file(&second_path).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_failure_contains(&output, "ambiguous codex session restore path");
    assert!(output.stdout.is_empty());
    assert!(first_path.exists());
    assert!(second_path.exists());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(!stderr.contains(first_path.to_str().unwrap()));
    assert!(!stderr.contains(second_path.to_str().unwrap()));
}

#[test]
fn cleanup_script_does_not_disclose_candidate_when_deletion_fails() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let existing_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    create_file(&existing_path).unwrap();

    let fake_bin = temp.path().join("fake-bin");
    fs::create_dir(&fake_bin).unwrap();
    let fake_rm = fake_bin.join("rm");
    fs::write(&fake_rm, "#!/bin/sh\nprintf '%s\\n' \"$*\" >&2\nexit 1\n").unwrap();
    let mut permissions = fs::metadata(&fake_rm).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_rm, permissions).unwrap();
    let path = format!("{}:{}", fake_bin.display(), std::env::var("PATH").unwrap());

    let output = cleanup_command(
        &codex_home,
        &fallback_path,
        SESSION_ID,
        SESSION_ID_NO_DASHES,
    )
    .env("PATH", path)
    .output()
    .unwrap();

    assert_failure_contains(&output, "failed to delete codex session files");
    assert!(output.stdout.is_empty());
    assert!(existing_path.exists());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(!stderr.contains(existing_path.to_str().unwrap()));
}

#[test]
fn cleanup_script_does_not_select_noncanonical_date_or_time() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let invalid_date = canonical_path(&codex_home, "2026-02-31", "04-01-04");
    let invalid_time = canonical_path(&codex_home, "2026-07-23", "24-01-04");
    create_file(&invalid_date).unwrap();
    create_file(&invalid_time).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert!(output.stdout.is_empty());
    assert!(!invalid_date.exists());
    assert!(!invalid_time.exists());
}

#[test]
fn cleanup_script_does_not_follow_symlinked_date_directory() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let external_root = temp.path().join("external");
    let external_path = canonical_path(&external_root, "2026-07-23", "04-01-04");
    create_file(&external_path).unwrap();
    let sessions_year = codex_home.join("sessions/2026");
    fs::create_dir_all(&sessions_year).unwrap();
    symlink(
        external_root.join("sessions/2026/07"),
        sessions_year.join("07"),
    )
    .unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert!(output.stdout.is_empty());
    assert!(external_path.exists());
}

#[test]
fn cleanup_script_does_not_select_canonical_symlink() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let fallback_path = restore_path(&codex_home);
    let symlink_path = canonical_path(&codex_home, "2026-07-23", "04-01-04");
    let target = temp.path().join("target.jsonl");
    create_file(&target).unwrap();
    fs::create_dir_all(symlink_path.parent().unwrap()).unwrap();
    symlink(&target, &symlink_path).unwrap();

    let output = run_cleanup(&codex_home, &fallback_path).unwrap();

    assert_success(&output);
    assert!(output.stdout.is_empty());
    assert!(!symlink_path.exists());
    assert!(target.exists());
}

#[test]
fn cleanup_script_fails_when_scan_budget_exceeded_without_deleting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
    let original_contents = "existing session history\n";
    fs::write(&matching_jsonl, original_contents).unwrap();
    let overflow_entry = restore_dir.join("unrelated.jsonl");
    create_file(&overflow_entry).unwrap();

    // Collect a real match before overflow, independent of filesystem enumeration order.
    let fake_bin = temp.path().join("fake-bin");
    fs::create_dir(&fake_bin).unwrap();
    let fake_find = fake_bin.join("find");
    fs::write(
        &fake_find,
        format!(
            "#!/bin/sh\nprintf 'f%s\\000f%s\\000' {} {}\n",
            quote_shell_arg(matching_jsonl.to_str().unwrap()),
            quote_shell_arg(overflow_entry.to_str().unwrap()),
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_find).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_find, permissions).unwrap();
    let path = format!("{}:{}", fake_bin.display(), std::env::var("PATH").unwrap());

    let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
        .env("PATH", path)
        .env("OKOU_CODEX_SESSION_CLEANUP_SCAN_BUDGET", "1")
        .output()
        .unwrap();

    assert_failure_contains(&output, "codex session cleanup exceeded scan budget");
    assert!(output.stdout.is_empty());
    assert!(matching_jsonl.exists());
    assert_eq!(
        fs::read_to_string(&matching_jsonl).unwrap(),
        original_contents
    );
}

#[test]
fn cleanup_script_rejects_invalid_scan_budget_without_deleting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
    create_file(&matching_jsonl).unwrap();

    for budget in ["0", "1000000", "not-a-number"] {
        let output = run_cleanup_with_budget(&codex_home, &restore_path, budget).unwrap();

        assert_failure_contains(&output, "invalid codex session cleanup scan budget");
        assert!(matching_jsonl.exists());
    }
}

#[test]
fn cleanup_script_accepts_uppercase_session_id() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
    create_file(&matching_jsonl).unwrap();

    let output =
        run_cleanup_with_session_id(&codex_home, &restore_path, &SESSION_ID.to_ascii_uppercase())
            .unwrap();

    assert_success(&output);
    assert!(!matching_jsonl.exists());
}

#[test]
fn cleanup_script_rejects_failed_session_id_normalization_without_deleting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let matching_jsonl = restore_dir.join(format!("rollout-a-{SESSION_ID}.jsonl"));
    create_file(&matching_jsonl).unwrap();

    let fake_bin = temp.path().join("fake-bin");
    fs::create_dir(&fake_bin).unwrap();
    symlink("/bin/sh", fake_bin.join("sh")).unwrap();
    let fake_tr = fake_bin.join("tr");
    fs::write(&fake_tr, "#!/bin/sh\nexit 1\n").unwrap();
    let mut permissions = fs::metadata(&fake_tr).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_tr, permissions).unwrap();

    let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
        .env("PATH", &fake_bin)
        .output()
        .unwrap();

    assert_failure_contains(&output, "failed to normalize codex restore session id");
    assert!(matching_jsonl.exists());
}

#[test]
fn cleanup_script_rejects_restore_path_outside_sessions_root() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    fs::create_dir_all(codex_home.join("sessions")).unwrap();
    let outside_restore_path = temp
        .path()
        .join(format!("outside/rollout-{SESSION_ID}.jsonl"));

    let output = run_cleanup(&codex_home, &outside_restore_path).unwrap();

    assert_failure_contains(&output, "invalid codex restore directory");
}

#[test]
fn cleanup_script_rejects_symlink_codex_home() {
    let temp = tempfile::tempdir().unwrap();
    let real_codex_home = temp.path().join("real-codex");
    let codex_home = temp.path().join(".codex");
    fs::create_dir_all(real_codex_home.join("sessions/2026/06/04")).unwrap();
    symlink(&real_codex_home, &codex_home).unwrap();
    let restore_path = restore_path(&codex_home);

    let output = run_cleanup(&codex_home, &restore_path).unwrap();

    assert_failure_contains(&output, "codex restore directory is a symlink");
}

#[test]
fn cleanup_script_rejects_non_directory_restore_component() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let root = codex_home.join("sessions");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("2026"), "not a directory").unwrap();
    let restore_path = restore_path(&codex_home);

    let output = run_cleanup(&codex_home, &restore_path).unwrap();

    assert_failure_contains(&output, "codex restore path component is not a directory");
}

#[test]
fn cleanup_script_succeeds_when_sessions_root_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    fs::create_dir_all(&codex_home).unwrap();
    let restore_path = restore_path(&codex_home);

    let output = cleanup_command(&codex_home, &restore_path, SESSION_ID, SESSION_ID_NO_DASHES)
        .env("TMPDIR", temp.path().join("missing-tmp"))
        .output()
        .unwrap();

    assert_success(&output);
}

#[test]
fn cleanup_script_rejects_restore_path_without_date_depth() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let root = codex_home.join("sessions");
    fs::create_dir_all(&root).unwrap();
    let shallow_restore_path = root.join(format!("rollout-{SESSION_ID}.jsonl"));

    let output = run_cleanup(&codex_home, &shallow_restore_path).unwrap();

    assert_failure_contains(&output, "invalid codex restore directory");
}

#[test]
fn cleanup_script_rejects_empty_session_id_without_deleting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let existing_session = restore_dir.join("rollout-existing-session.jsonl");
    create_file(&existing_session).unwrap();

    let output = run_cleanup_with_session_id(&codex_home, &restore_path, "").unwrap();

    assert_failure_contains(&output, "invalid codex restore session id");
    assert!(existing_session.exists());
}

#[test]
fn cleanup_script_rejects_invalid_session_id_with_valid_filename_key_without_deleting_sessions() {
    for invalid_session_id in ["", "*"] {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join(".codex");
        let restore_path = restore_path(&codex_home);
        let restore_dir = restore_path.parent().unwrap();
        fs::create_dir_all(restore_dir).unwrap();
        let existing_session = restore_dir.join("rollout-existing-session.jsonl");
        create_file(&existing_session).unwrap();

        let output = run_cleanup_with_session_identity(
            &codex_home,
            &restore_path,
            invalid_session_id,
            SESSION_ID_NO_DASHES,
        )
        .unwrap();

        assert_failure_contains(&output, "invalid codex restore session id");
        assert!(existing_session.exists());
    }
}

#[test]
fn cleanup_script_rejects_glob_session_id_without_deleting_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let codex_home = temp.path().join(".codex");
    let restore_path = restore_path(&codex_home);
    let restore_dir = restore_path.parent().unwrap();
    fs::create_dir_all(restore_dir).unwrap();
    let existing_session = restore_dir.join("rollout-existing-session.jsonl");
    create_file(&existing_session).unwrap();

    let output = run_cleanup_with_session_id(&codex_home, &restore_path, "*").unwrap();

    assert_failure_contains(&output, "invalid codex restore session id");
    assert!(existing_session.exists());
}
