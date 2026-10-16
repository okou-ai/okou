use guest_agent::http::HttpClient;

#[test]
fn for_config_requires_api_url_when_api_token_is_set() {
    let tmp = tempfile::tempdir().expect("create temp dir");
    let runtime_dir = tmp.path().join("runtime");
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&run_payload_dir).expect("create run payload dir");
    std::fs::write(
        &run_payload_path,
        serde_json::to_vec(&guest_contracts::env::RunPayload::default())
            .expect("serialize run payload"),
    )
    .expect("write run payload");

    let config = guest_agent::env::GuestConfig::from_raw(guest_agent::env::GuestConfigRaw {
        run_id: "http-missing-api-url".to_string(),
        api_token: "test-token".to_string(),
        home: Some(tmp.path().to_string_lossy().into_owned()),
        run_payload_file: run_payload_path.to_string_lossy().into_owned(),
        guest_runtime_dir: Some(runtime_dir),
        ..Default::default()
    })
    .expect("test config should be valid");

    let Err(err) = HttpClient::for_config(&config) else {
        panic!("missing API URL should fail fast");
    };
    assert!(
        err.to_string()
            .contains(guest_contracts::env::CANONICAL_API_URL_ENV),
        "error should identify {}, got: {err}",
        guest_contracts::env::CANONICAL_API_URL_ENV
    );
}
