use super::super::{
    R2Error,
    keys::key_for_template_hash,
    multipart::MultipartUploadGuard,
    test_support::{Operation, Rule},
};
use super::fixtures::{mock_cache, small_src_file, wait_for_rule_calls};

// The operation-level double checks cache orchestration. Real signed HTTP,
// checksums and REST-XML behavior are covered by the HTTP integration tests.
fn multipart_success_rules() -> (Rule, Rule, Rule) {
    (
        Rule::create(Some("test-upload-id")),
        Rule::upload_part(Some("\"etag-123\"")),
        Rule::complete(),
    )
}

#[tokio::test]
async fn upload_force_true_bypasses_exists_check() {
    let head = Rule::head(true);
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);
    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, true).await.unwrap();
    assert_eq!(head.num_calls(), 0, "force=true must skip head_object");
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[tokio::test]
async fn upload_force_false_dedup_skips_when_exists() {
    let head = Rule::head(true);
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);
    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, false).await.unwrap();
    assert_eq!(head.num_calls(), 1);
    assert_eq!(create.num_calls(), 0);
    assert_eq!(upload_part.num_calls(), 0);
    assert_eq!(complete.num_calls(), 0);
}

#[tokio::test]
async fn upload_force_false_proceeds_when_not_found() {
    let head = Rule::head(false);
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);
    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, false).await.unwrap();
    assert_eq!(head.num_calls(), 1);
    assert_eq!(create.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[tokio::test]
async fn upload_template_uses_template_prefix() {
    let correct_key = "runner-templates/abc.tar.zst";
    let create = Rule::create(Some("test-upload-id"))
        .with_matcher(move |req| req.bucket == "test-bucket" && req.key == correct_key);
    let upload_part = Rule::upload_part(Some("\"etag-123\"")).with_matcher(move |req| {
        req.bucket == "test-bucket"
            && req.key == correct_key
            && req.upload_id == Some("test-upload-id")
            && req.part_number == Some(1)
    });
    let complete = Rule::complete().with_matcher(move |req| {
        req.bucket == "test-bucket"
            && req.key == correct_key
            && req.upload_id == Some("test-upload-id")
            && req.parts == [(1, "\"etag-123\"".to_string())]
    });
    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete]);
    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, true).await.unwrap();
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

#[tokio::test]
async fn upload_aborts_multipart_when_complete_fails() {
    let (create, upload_part, _) = multipart_success_rules();
    let complete = Rule::fail(Operation::Complete, "InternalError");
    let abort = Rule::abort();
    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);
    let (_dir, path) = small_src_file().await;
    let result = cache.upload_template("abc", &path, true).await;
    assert!(matches!(result, Err(R2Error::S3(_))), "{result:?}");
    assert_eq!(complete.num_calls(), 1);
    assert_eq!(abort.num_calls(), 1, "abort MUST run on Complete failure");
}

#[tokio::test]
async fn multipart_upload_guard_aborts_on_drop() {
    let abort = Rule::abort().with_matcher(|req| {
        req.bucket == "test-bucket"
            && req.key == "runner-templates/abc.tar.zst"
            && req.upload_id == Some("test-upload-id")
    });
    let cache = mock_cache("test-bucket", &[&abort]);
    drop(MultipartUploadGuard::new(
        cache.client.clone(),
        cache.bucket.clone(),
        key_for_template_hash("abc"),
        "test-upload-id".to_string(),
    ));
    wait_for_rule_calls(&abort, 1).await;
}

#[tokio::test]
async fn upload_part_missing_etag_errors_with_part_number() {
    let create = Rule::create(Some("test-upload-id"));
    let upload_part = Rule::upload_part(None);
    let complete = Rule::complete();
    let abort = Rule::abort();
    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);
    let (_dir, path) = small_src_file().await;
    let err = cache.upload_template("abc", &path, true).await.unwrap_err();
    match err {
        R2Error::S3(msg) => {
            assert!(msg.contains("upload_part 1"), "{msg}");
            assert!(msg.contains("missing e_tag"), "{msg}");
        }
        other => panic!("expected R2Error::S3, got {other:?}"),
    }
    assert_eq!(abort.num_calls(), 1);
    assert_eq!(complete.num_calls(), 0);
}

#[tokio::test]
async fn upload_missing_template_source_aborts_multipart() {
    let create = Rule::create(Some("test-upload-id"));
    let abort = Rule::abort();
    let cache = mock_cache("test-bucket", &[&create, &abort]);
    let missing = std::path::Path::new("/definitely/missing/template.ext4");
    let error = cache
        .upload_template("abc", missing, true)
        .await
        .unwrap_err();
    assert!(matches!(error, R2Error::Io(_)));
    assert_eq!(abort.num_calls(), 1);
}
