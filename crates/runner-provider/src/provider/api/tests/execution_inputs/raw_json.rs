use super::*;

fn prefix(member: &str) -> String {
    format!(
        "{{{member},{}",
        RUNNER_EXECUTION_CONTEXT_FIXTURE
            .trim()
            .trim_start_matches('{')
    )
}

fn bundles() -> String {
    let fixture: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    fixture["startupInputs"].to_string()
}

fn reject(body: &str, expected: &str) {
    let error = decode_execution_publication(body.as_bytes()).unwrap_err();
    assert_eq!(error, expected);
    assert!(!error.contains("private-secret"));
}

#[test]
fn raw_publication_preserves_unknown_and_skipped_fields_without_coercing_them() {
    let body = prefix(
        r#""future":{"number":1e400,"repeated":1,"repeated":2},"localResumeSessionId":{"private-secret":1},"localSecretEnvKeys":false,"instructionFile":"forged""#,
    );
    let context = decode_execution_publication(body.as_bytes()).unwrap();
    assert_eq!(context.prompt, "Inspect the fixture repository");
    assert!(context.local_resume_session_id.is_none());
    assert!(context.local_secret_env_keys.is_none());
    assert_eq!(
        context.instruction_file.unwrap().storage_mount,
        "/home/user/.vm0/agent-instructions/codex"
    );
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body["startupInputs"]["contentBundles"]["futureBundles"] = Value::Bool(true);
    body["startupInputs"]["contentBundles"]["skills"][0]["futureSkill"] = Value::Bool(true);
    assert_eq!(
        decode_execution_publication(body.to_string().as_bytes())
            .unwrap()
            .storage_manifest,
        context.storage_manifest,
    );
    let body = RUNNER_EXECUTION_CONTEXT_FIXTURE.replace("\"prompt\"", r#""\u0070rompt""#);
    assert_eq!(
        decode_execution_publication(body.as_bytes())
            .unwrap()
            .prompt,
        "Inspect the fixture repository"
    );
}

#[test]
fn raw_publication_rejects_duplicate_context_and_bundle_members() {
    for member in [
        r#""runId":"00000000-0000-4000-8000-000000020985""#.to_owned(),
        r#""userTimezone":null"#.to_owned(),
        r#""prompt":"private-secret""#.to_owned(),
        format!(r#""startupInputs":{}"#, bundles()),
        format!(r#""\u0073tartupInputs":{}"#, bundles()),
    ] {
        let expected = if member.contains("Inputs") {
            "Invalid startup inputs"
        } else {
            "Invalid execution context"
        };
        reject(&prefix(&member), expected);
    }
    let duplicate = bundles().replacen(
        "\"archiveBytes\":128",
        "\"archiveBytes\":128,\"archiveBytes\":128",
        1,
    );
    assert_ne!(duplicate, bundles());
    let fixture: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    let mut context = fixture.as_object().unwrap().clone();
    context.remove("startupInputs");
    let rest = serde_json::to_string(&context).unwrap();
    reject(
        &format!(r#"{{"startupInputs":{duplicate},{}"#, &rest[1..]),
        "Invalid startup inputs",
    );
}

#[test]
fn raw_publication_preserves_missing_and_null_semantics() {
    let fixture: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    let mut context = fixture.as_object().unwrap().clone();
    context.remove("startupInputs");
    let rest = serde_json::to_string(&context).unwrap();
    reject(&rest, "Invalid startup inputs");
    for package in [
        "null".to_owned(),
        r#"{"memory":null,"contentBundles":{"format":"tar-gzip-v1","skills":[],"instructions":null}}"#.to_owned(),
        r#"{"memory":null,"contentBundles":{"format":"tar-gzip-v1","skills":null}}"#.to_owned(),
        r#"{"memory":null,"contentBundles":{"format":"tar-gzip-v1","skills":[],"templates":null}}"#.to_owned(),
    ] {
        reject(
            &format!(r#"{{"startupInputs":{package},{}"#, &rest[1..]),
            "Invalid startup inputs",
        );
    }
    for key in [
        "apiStartTime",
        "userTimezone",
        "captureNetworkBodies",
        "vars",
    ] {
        let mut body = fixture.clone();
        body[key] = Value::Null;
        let decoded = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap();
        match key {
            "apiStartTime" => assert!(decoded.api_start_time.is_none()),
            "userTimezone" => assert!(decoded.user_timezone.is_none()),
            "captureNetworkBodies" => assert!(decoded.capture_network_bodies.is_none()),
            _ => assert!(decoded.vars.is_none()),
        }
    }
    let mut body = fixture.clone();
    body["apiStartTime"] = serde_json::json!(u64::MAX);
    assert_eq!(
        decode_execution_publication(&serde_json::to_vec(&body).unwrap())
            .unwrap()
            .api_start_time,
        Some(u64::MAX)
    );
}

#[test]
fn raw_publication_keeps_context_first_redacted_errors_and_trailing_rejection() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body["startupInputs"]["contentBundles"] = Value::Null;
    for key in [
        "sandboxToken",
        "firewallToken",
        "platformEnvironment",
        "apiStartTime",
    ] {
        let mut invalid = body.clone();
        invalid[key] = serde_json::json!({"private-secret": true});
        reject(
            &serde_json::to_string(&invalid).unwrap(),
            "Invalid execution context",
        );
    }
    let mut missing = body.clone();
    missing.as_object_mut().unwrap().remove("runId");
    reject(
        &serde_json::to_string(&missing).unwrap(),
        "Invalid execution context",
    );
    for tail in [" {}", " private-secret", ",", "\0"] {
        reject(
            &format!("{RUNNER_EXECUTION_CONTEXT_FIXTURE}{tail}"),
            "Invalid execution context",
        );
    }
    let broken = RUNNER_EXECUTION_CONTEXT_FIXTURE
        .trim()
        .trim_end_matches('}');
    reject(broken, "Invalid execution context");
    reject("null", "Invalid execution context");
    reject("[]", "Invalid execution context");
}

#[test]
fn publication_requires_host_firewall_authority() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body.as_object_mut().unwrap().remove("firewallToken");
    reject(&body.to_string(), "Invalid execution context");
    for value in [Value::Null, Value::String(String::new())] {
        body["firewallToken"] = value;
        reject(&body.to_string(), "Invalid execution context");
    }
}

#[test]
fn raw_publication_accepts_bundles_before_or_after_context_with_escaped_keys() {
    let mut fixture: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    let packages = fixture
        .as_object_mut()
        .unwrap()
        .remove("startupInputs")
        .unwrap();
    let rest = serde_json::to_string(&fixture).unwrap();
    for body in [
        format!(r#"{{"\u0073tartupInputs":{packages},{}"#, &rest[1..]),
        format!(
            r#"{},"startupInputs":{packages}}}"#,
            rest.strip_suffix('}').unwrap()
        ),
    ] {
        let context = decode_execution_publication(body.as_bytes()).unwrap();
        assert_eq!(context.prompt, "Inspect the fixture repository");
        assert_eq!(context.storage_manifest.unwrap().storages.len(), 2);
    }
}
