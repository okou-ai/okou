use super::*;
use guest_contracts::session_history_identity::{
    SessionHistoryFramework, SessionHistoryIdentity, SessionHistoryIdentityExpectation,
    SessionHistoryRefKind, SessionHistorySourceRef,
};

fn owned_home_fixture() -> tempfile::TempDir {
    // The canonical Guest home need not exist in a host/CI test container.
    // Only the UUID-owned child is removed; concurrent tests never remove
    // the shared parent. Canonical history files are separately UUID-owned.
    std::fs::create_dir_all("/home/user").unwrap();
    tempfile::tempdir_in("/home/user").unwrap()
}

#[test]
fn retained_codex_raw_and_zstd_use_real_bytes_and_reject_ambiguity_or_corruption() {
    let dir = owned_home_fixture();
    let runtime = dir.path().join("runtime/current");
    let proof_path = dir.path().join("cache/proof.json");
    let thread = uuid::Uuid::new_v4().to_string();
    let day = Path::new("/home/user/.codex/sessions/2026/10/09");
    std::fs::create_dir_all(day).unwrap();
    let raw = day.join(format!("rollout-{}.jsonl", thread.replace('-', "")));
    let encoded = raw.with_extension("jsonl.zst");
    struct OwnedHistories(Vec<PathBuf>);
    impl Drop for OwnedHistories {
        fn drop(&mut self) {
            for path in &self.0 {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let _owned = OwnedHistories(vec![raw.clone(), encoded.clone()]);
    let history = br#"{"type":"session_meta","timestamp":"2026-10-09T00:00:00Z"}"#;
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::Codex,
        hex::encode(Sha256::digest(thread.as_bytes())),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(history)),
        history.len() as u64,
        SessionHistorySourceRef::Codex {
            sessions_dir: "/home/user/.codex/sessions".into(),
            thread_id: thread,
        },
    )
    .unwrap();
    let metadata = guest_contracts::runtime_paths::final_session_history_identity_file(&runtime);
    guest_contracts::runtime_paths::write_private(&metadata, identity.to_json_vec().unwrap())
        .unwrap();
    for zstd in [false, true] {
        let _ = std::fs::remove_file(&raw);
        let _ = std::fs::remove_file(&encoded);
        if zstd {
            std::fs::write(&encoded, zstd::encode_all(history.as_slice(), 0).unwrap()).unwrap();
        } else {
            std::fs::write(&raw, history).unwrap();
        }
        let binding = capture_at_path(
            Some(&runtime),
            None,
            "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
            &proof_path,
        )
        .persist()
        .unwrap()
        .unwrap();
        let request = HomeCacheHistoryVerifyRequest {
            expected: SessionHistoryIdentityExpectation::new(
                identity.framework,
                identity.session_id_hash.clone(),
                identity.history_ref_kind,
                identity.history_hash.clone(),
                identity.history_size_bytes,
            )
            .unwrap(),
            source: identity.history_source.clone(),
            binding,
        };
        assert!(verify_at_path(&request, &proof_path));
        if zstd {
            let mut corrupt = std::fs::read(&encoded).unwrap();
            corrupt.pop().unwrap();
            std::fs::write(&encoded, corrupt).unwrap();
            assert!(!verify_at_path(&request, &proof_path));
            std::fs::write(&encoded, zstd::encode_all(history.as_slice(), 0).unwrap()).unwrap();
        }
        std::fs::write(
            if zstd { &raw } else { &encoded },
            if zstd {
                history.to_vec()
            } else {
                zstd::encode_all(history.as_slice(), 0).unwrap()
            },
        )
        .unwrap();
        assert!(!verify_at_path(&request, &proof_path));
        assert!(
            capture_at_path(
                Some(&runtime),
                None,
                "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
                &proof_path
            )
            .persist()
            .unwrap()
            .is_none()
        );
        assert!(!proof_path.exists());
    }
}

#[test]
fn captured_live_bytes_and_surviving_proof_are_both_required() {
    // A real home-contained temp tree, not an overridden source reader.
    let dir = owned_home_fixture();
    let config = dir.path().join("claude");
    let history = config.join("projects/-home-user-workspace/session-1.jsonl");
    std::fs::create_dir_all(history.parent().unwrap()).unwrap();
    std::fs::write(&history, b"history").unwrap();
    let runtime = dir.path().join("runtime/current");
    let metadata = guest_contracts::runtime_paths::final_session_history_identity_file(&runtime);
    let identity = SessionHistoryIdentity::new(
        SessionHistoryFramework::ClaudeCode,
        hex::encode(Sha256::digest(b"session-1")),
        SessionHistoryRefKind::Blob,
        hex::encode(Sha256::digest(b"history")),
        7,
        SessionHistorySourceRef::ClaudeCode {
            config_dir: config.to_string_lossy().into_owned(),
            working_dir: "/home/user/workspace".into(),
            session_id: "session-1".into(),
        },
    )
    .unwrap();
    guest_contracts::runtime_paths::write_private(&metadata, identity.to_json_vec().unwrap())
        .unwrap();
    let proof_path = dir.path().join("cache/proof.json");
    let binding = capture_at_path(
        Some(&runtime),
        None,
        "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
        &proof_path,
    )
    .persist()
    .unwrap()
    .unwrap();
    let mut request = HomeCacheHistoryVerifyRequest {
        expected: SessionHistoryIdentityExpectation::new(
            identity.framework,
            identity.session_id_hash,
            identity.history_ref_kind,
            identity.history_hash,
            7,
        )
        .unwrap(),
        source: identity.history_source,
        binding,
    };
    assert!(verify_at_path(&request, &proof_path));
    std::fs::remove_dir_all(&runtime).unwrap();
    assert!(verify_at_path(&request, &proof_path));
    request.binding.proof.generation = uuid::Uuid::new_v4().to_string();
    assert!(!verify_at_path(&request, &proof_path));
    request.binding = HomeCacheHistoryProofBinding {
        proof: HomeCacheHistoryProof::from_json_slice(&std::fs::read(&proof_path).unwrap())
            .unwrap(),
        sha256: hex::encode(Sha256::digest(std::fs::read(&proof_path).unwrap())),
    };
    request.binding.sha256 = "f".repeat(64);
    assert!(!verify_at_path(&request, &proof_path));
    request.binding.sha256 = hex::encode(Sha256::digest(std::fs::read(&proof_path).unwrap()));
    std::fs::write(&history, b"changed").unwrap();
    assert!(!verify_at_path(&request, &proof_path));
    std::fs::write(&proof_path, b"corrupt").unwrap();
    assert!(!verify_at_path(&request, &proof_path));
    assert!(
        capture_at_path(
            Some(&runtime),
            None,
            "74b68da0-6e0a-4adc-a68e-65a04c4885c4",
            &proof_path
        )
        .persist()
        .unwrap()
        .is_none()
    );
    assert!(!proof_path.exists());
}
