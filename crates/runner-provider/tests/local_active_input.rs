#![cfg(test)]

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use nix::errno::Errno;
use nix::sys::inotify::{AddWatchFlags, InitFlags, Inotify};
use runner_provider::local_queue::{self, ActiveInputEntry, LocalQueue};
use runner_provider::{
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES, identified_active_input_payload_len,
};
use runner_types::ids::RunId;

fn queue_with_job(group_dir: &Path, run_id: RunId) -> LocalQueue {
    let profile = runner_types::profile_name::DEFAULT_PROFILE;
    local_queue::ensure_profile_jobs_dir(group_dir, profile).unwrap();
    local_queue::write_private_file(
        &local_queue::job_path(group_dir, profile, run_id).unwrap(),
        b"{}",
        "test local job",
    )
    .unwrap();
    LocalQueue::new(group_dir.to_path_buf())
}

fn watch_payloads(group_dir: &Path, run_id: RunId) -> Inotify {
    let watcher = Inotify::init(InitFlags::IN_CLOEXEC | InitFlags::IN_NONBLOCK).unwrap();
    watcher
        .add_watch(
            &local_queue::run_inputs_dir(group_dir, run_id),
            AddWatchFlags::IN_OPEN | AddWatchFlags::IN_ACCESS,
        )
        .unwrap();
    watcher
}

fn payload_accesses(watcher: &Inotify) -> BTreeSet<OsString> {
    let mut names = BTreeSet::new();
    loop {
        match watcher.read_events() {
            Ok(events) => {
                for event in events {
                    assert!(!event.mask.contains(AddWatchFlags::IN_Q_OVERFLOW));
                    if let Some(name) = event.name
                        && Path::new(&name)
                            .extension()
                            .is_some_and(|ext| ext == "json")
                    {
                        names.insert(name);
                    }
                }
            }
            Err(Errno::EAGAIN) => return names,
            Err(error) => panic!("read payload access events: {error}"),
        }
    }
}

fn write_future_inputs(
    group_dir: &Path,
    entry: &ActiveInputEntry,
    sequences: impl IntoIterator<Item = u64>,
) {
    local_queue::ensure_run_inputs_dir(group_dir, entry.run_id).unwrap();
    let run_id = serde_json::to_string(&entry.run_id).unwrap();
    let text = serde_json::to_string(&entry.text).unwrap();
    for sequence in sequences {
        let path = local_queue::active_input_path(group_dir, entry.run_id, sequence);
        let mut file = local_queue::open_private_new_file(&path, "future input fixture").unwrap();
        // Keep ActiveInputEntry's field order; Serde escapes each invariant
        // scalar once. Every sequence still owns its complete private file.
        write!(
            file,
            r#"{{"runId":{run_id},"sequence":{sequence},"text":{text}}}"#,
        )
        .unwrap();
    }
}

#[test]
fn future_input_fixture_preserves_canonical_bytes_and_private_independent_files() {
    let sequences = [2, 9, 10, 99, 100, 1001, u64::MAX];
    for text in [
        "plain",
        "你\"\\\n\0\tsequence",
        r#"{"runId":"sequence","sequence":0}"#,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = ActiveInputEntry {
            run_id: RunId::from(uuid::Uuid::nil()),
            sequence: 2,
            text: text.to_owned(),
        };
        write_future_inputs(dir.path(), &entry, sequences);
        for path in [
            local_queue::inputs_dir(dir.path()),
            local_queue::run_inputs_dir(dir.path(), entry.run_id),
        ] {
            assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o700);
        }
        let mut inodes = BTreeSet::new();
        for sequence in sequences {
            entry.sequence = sequence;
            let path = local_queue::active_input_path(dir.path(), entry.run_id, sequence);
            assert_eq!(
                std::fs::read(&path).unwrap(),
                serde_json::to_vec(&entry).unwrap()
            );
            let metadata = std::fs::metadata(path).unwrap();
            assert_eq!(metadata.mode() & 0o777, 0o600);
            assert_eq!(metadata.nlink(), 1);
            assert!(inodes.insert(metadata.ino()));
        }
    }
}

#[test]
fn missing_sequence_never_opens_a_large_future_backlog() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = queue_with_job(dir.path(), run_id);
    let mut entry = ActiveInputEntry {
        run_id,
        sequence: 2,
        text: "x".repeat(100 * 1024),
    };
    // Only reader gap behavior is observed here; publication/admission has
    // separate owner coverage. Prepare the entire unpublished backlog first.
    write_future_inputs(dir.path(), &entry, 2..=1001);
    let watcher = watch_payloads(dir.path(), run_id);

    for _ in 0..3 {
        assert_eq!(queue.read_active_input_entry_sync(run_id, 1), None);
        assert!(payload_accesses(&watcher).is_empty());
    }

    entry.sequence = 1;
    queue.write_active_input_sync(&entry).unwrap();
    for sequence in 1..=3 {
        entry.sequence = sequence;
        let read = queue
            .read_active_input_entry_sync(run_id, sequence)
            .unwrap();
        assert!(read.text.len() <= local_queue::LOCAL_ACTIVE_INPUT_MAX_BYTES);
        assert_eq!(read, entry);
        assert_eq!(
            payload_accesses(&watcher),
            BTreeSet::from([OsString::from(format!("{sequence:020}.json"))])
        );
    }
}

#[test]
fn reader_accepts_the_maximum_cli_payload_with_maximum_sequence_metadata() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = queue_with_job(dir.path(), run_id);
    let overhead = identified_active_input_payload_len("").unwrap();
    let budget = ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - overhead;
    for fragment in ["x", "\"\\\n\u{1f}é"] {
        let width = identified_active_input_payload_len(fragment).unwrap() - overhead;
        let mut text = fragment.repeat(budget / width);
        text.push_str(&"x".repeat(budget % width));
        let entry = ActiveInputEntry {
            run_id,
            sequence: u64::MAX,
            text,
        };
        assert_eq!(
            identified_active_input_payload_len(&entry.text).unwrap(),
            ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES
        );
        assert!(
            serde_json::to_vec(&entry).unwrap().len() <= local_queue::LOCAL_ACTIVE_INPUT_MAX_BYTES
        );
        queue.write_active_input_sync(&entry).unwrap();
        assert_eq!(
            queue.read_active_input_entry_sync(run_id, u64::MAX),
            Some(entry)
        );
        queue.cleanup_active_inputs_sync(run_id);
    }
}

#[test]
fn serialized_entry_budget_is_inclusive_and_oversized_expected_input_blocks() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let queue = queue_with_job(dir.path(), run_id);
    let mut entry = ActiveInputEntry {
        run_id,
        sequence: 1,
        text: String::new(),
    };
    let overhead = serde_json::to_vec(&entry).unwrap().len();
    entry.text = "x".repeat(local_queue::LOCAL_ACTIVE_INPUT_MAX_BYTES - overhead);
    queue.write_active_input_sync(&entry).unwrap();
    assert_eq!(
        serde_json::to_vec(&entry).unwrap().len(),
        local_queue::LOCAL_ACTIVE_INPUT_MAX_BYTES
    );
    assert_eq!(
        queue.read_active_input_entry_sync(run_id, 1).as_ref(),
        Some(&entry)
    );

    entry.text.push('x');
    local_queue::write_private_file(
        &local_queue::active_input_path(dir.path(), run_id, 1),
        &serde_json::to_vec(&entry).unwrap(),
        "oversized test input",
    )
    .unwrap();
    queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id,
            sequence: 2,
            text: "later input".to_owned(),
        })
        .unwrap();
    let watcher = watch_payloads(dir.path(), run_id);
    assert_eq!(queue.read_active_input_entry_sync(run_id, 1), None);
    assert_eq!(
        payload_accesses(&watcher),
        BTreeSet::from([OsString::from(format!("{:020}.json", 1))])
    );
}
