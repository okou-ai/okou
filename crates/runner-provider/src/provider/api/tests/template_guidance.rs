use super::*;

const TEMPLATE_ID: &str = "859550cb-28ad-47ef-8728-f6b3849f8c55";

fn template(owner: &str) -> Value {
    serde_json::json!({"ownerKind":owner,"templateId":TEMPLATE_ID,"beforeMountPaths":[],"sha256":"a".repeat(64),"archiveBytes":40*1024*1024,"downloadUrl":"https://example.test/template.tar.gz"})
}

#[test]
fn publication_accepts_large_template_bundles_in_separate_owner_directories() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    body["contentBundles"]["templates"] =
        serde_json::json!([template("user-template"), template("presentation-template")]);
    let response = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap();
    let entries = response
        .storage_manifest
        .unwrap()
        .storages
        .into_iter()
        .filter(|entry| entry.vas_storage_name == "template-guidance")
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].mount_path,
        format!("/home/user/workspace/generated/user-template/{TEMPLATE_ID}")
    );
    assert_eq!(
        entries[1].mount_path,
        format!("/home/user/workspace/generated/presentation-template/{TEMPLATE_ID}")
    );
    assert!(
        entries
            .iter()
            .all(|entry| entry.archive_size == Some(40 * 1024 * 1024)
                && entry.vas_version_id == "a".repeat(64))
    );
}

#[test]
fn publication_rejects_unsafe_template_owners_references_and_duplicate_mounts() {
    for kind in ["owner", "id", "size", "url", "duplicate", "overlap", "null"] {
        let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
        body["contentBundles"]["templates"] = serde_json::json!([template("user-template")]);
        match kind {
            "owner" => {
                body["contentBundles"]["templates"][0]["ownerKind"] = serde_json::json!("other")
            }
            "id" => {
                body["contentBundles"]["templates"][0]["templateId"] =
                    serde_json::json!("../../escape")
            }
            "size" => {
                body["contentBundles"]["templates"][0]["archiveBytes"] =
                    serde_json::json!(104 * 1024 * 1024)
            }
            "url" => {
                body["contentBundles"]["templates"][0]["downloadUrl"] =
                    serde_json::json!("https://secret-fixture@example.test/archive")
            }
            "duplicate" => {
                body["contentBundles"]["templates"] =
                    serde_json::json!([template("user-template"), template("user-template")])
            }
            "null" => body["contentBundles"]["templates"] = Value::Null,
            _ => {
                let mut mount = body["storageManifest"]["storageMounts"][0].clone();
                mount["mountPath"] = serde_json::json!(format!(
                    "/home/user/workspace/generated/user-template/{TEMPLATE_ID}"
                ));
                body["storageManifest"]["storageMounts"]
                    .as_array_mut()
                    .unwrap()
                    .push(mount);
            }
        }
        let error = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap_err();
        assert!(!error.contains("secret-fixture"));
    }
}

#[test]
fn publication_preserves_template_order_before_explicit_overlay_mounts() {
    let mut body: Value = serde_json::from_str(RUNNER_EXECUTION_CONTEXT_FIXTURE).unwrap();
    let target = format!("/home/user/workspace/generated/user-template/{TEMPLATE_ID}/references");
    let mut overlay = body["storageManifest"]["storageMounts"][0].clone();
    overlay["mountPath"] = serde_json::json!(target);
    body["storageManifest"]["storageMounts"]
        .as_array_mut()
        .unwrap()
        .push(overlay);
    let mut first = template("user-template");
    let mut second = template("presentation-template");
    // Optional unresolved mounts can be absent from the final legacy manifest.
    first["beforeMountPaths"] = serde_json::json!(["/missing-optional-volume", target]);
    second["beforeMountPaths"] = serde_json::json!([target]);
    body["contentBundles"]["templates"] = serde_json::json!([first, second]);
    let response = decode_execution_publication(&serde_json::to_vec(&body).unwrap()).unwrap();
    let entries = response.storage_manifest.unwrap().storages;
    let first_index = entries
        .iter()
        .position(|entry| {
            entry.mount_path
                == format!("/home/user/workspace/generated/user-template/{TEMPLATE_ID}")
        })
        .unwrap();
    let second_index = entries
        .iter()
        .position(|entry| {
            entry.mount_path
                == format!("/home/user/workspace/generated/presentation-template/{TEMPLATE_ID}")
        })
        .unwrap();
    let overlay_index = entries
        .iter()
        .position(|entry| entry.mount_path == target)
        .unwrap();
    assert!(first_index < second_index && second_index < overlay_index);
}
