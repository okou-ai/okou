use super::super::{R2Error, keys::key_for_template_hash, multipart::MultipartUploadGuard};
use super::fixtures::{mock_cache, small_src_file, wait_for_rule_calls};
use aws_smithy_mocks::{Rule, mock};

// ---- upload: force + dedup + multipart lifecycle -------------------
//
// Size the payload below `PART_SIZE` (16 MiB) so the happy path issues
// exactly one `upload_part` — keeps the lifecycle mock setup compact.
// Multi-part scheduler ordering is covered by the focused inline tests in
// `multipart.rs`.

/// Mock-rule factory for the happy-path multipart triad.
/// Returns (create, upload_part, complete) rules. Caller wires them with
/// any head_object rule needed by the specific test.
fn multipart_success_rules() -> (Rule, Rule, Rule) {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    let upload_part = mock!(Client::upload_part)
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    let complete = mock!(Client::complete_multipart_upload)
        .then_output(|| CompleteMultipartUploadOutput::builder().build());
    (create, upload_part, complete)
}

/// `force = true` MUST NOT call `head_object` — the corrupt-eviction
/// contract: after detecting a bad object (download succeeded but
/// template.ext4 invalid), the caller relies on `upload_template(_, _, true)` to
/// force-overwrite without re-checking existence (which would still
/// say "exists, skip").
#[tokio::test]
async fn upload_force_true_bypasses_exists_check() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, true).await.unwrap();

    assert_eq!(head.num_calls(), 0, "force=true must skip head_object");
    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

/// `force = false` + object exists → dedup-skip; multipart triad never
/// runs. Saves bandwidth across peer hosts.
#[tokio::test]
async fn upload_force_false_dedup_skips_when_exists() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectOutput;

    let head = mock!(Client::head_object).then_output(|| HeadObjectOutput::builder().build());
    let (create, upload_part, complete) = multipart_success_rules();
    let cache = mock_cache("test-bucket", &[&head, &create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, false).await.unwrap();

    assert_eq!(head.num_calls(), 1, "head_object consulted exactly once");
    assert_eq!(
        create.num_calls(),
        0,
        "dedup short-circuits before multipart"
    );
    assert_eq!(upload_part.num_calls(), 0);
    assert_eq!(complete.num_calls(), 0);
}

/// `force = false` + `head_object` returns `NotFound` → proceed through
/// the full multipart pipeline. Distinct from force=true (which skips
/// head entirely) because here head IS consulted, it just returns miss.
#[tokio::test]
async fn upload_force_false_proceeds_when_not_found() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectError;
    use aws_sdk_s3::types::error::NotFound;

    let head = mock!(Client::head_object)
        .then_error(|| HeadObjectError::NotFound(NotFound::builder().build()));
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
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket") && req.key() == Some("runner-templates/abc.tar.zst")
        })
        .then_output(|| {
            CreateMultipartUploadOutput::builder()
                .upload_id("test-upload-id")
                .build()
        });
    let upload_part = mock!(Client::upload_part)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/abc.tar.zst")
                && req.upload_id() == Some("test-upload-id")
                && req.part_number() == Some(1)
        })
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    let complete = mock!(Client::complete_multipart_upload)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/abc.tar.zst")
                && req.upload_id() == Some("test-upload-id")
                && req.multipart_upload().is_some_and(|multipart| {
                    let parts = multipart.parts();
                    parts.len() == 1
                        && parts[0].part_number() == Some(1)
                        && parts[0].e_tag() == Some("\"etag-123\"")
                })
        })
        .then_output(|| CompleteMultipartUploadOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete]);

    let (_dir, path) = small_src_file().await;
    cache.upload_template("abc", &path, true).await.unwrap();

    assert_eq!(create.num_calls(), 1);
    assert_eq!(upload_part.num_calls(), 1);
    assert_eq!(complete.num_calls(), 1);
}

/// `complete_multipart_upload` failure (server-side validation after all
/// parts uploaded) MUST trigger `abort_multipart_upload`. Without this,
/// the abandoned upload_id lingers until R2's 7-day lifecycle sweeps it.
#[tokio::test]
async fn upload_aborts_multipart_when_complete_fails() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    let upload_part = mock!(Client::upload_part)
        .then_output(|| UploadPartOutput::builder().e_tag("\"etag-123\"").build());
    // CompleteMultipartUpload returns a 500 so the SDK surfaces it as an
    // SdkError — r2_cache converts that to R2Error::S3 via the From impl.
    // Using `http_status` (provided by `aws-smithy-mocks`) avoids
    // pulling `aws-smithy-types` / `aws-smithy-runtime-api` in as
    // explicit dev-deps.
    let complete = mock!(Client::complete_multipart_upload)
        .sequence()
        .http_status(
            500,
            Some("<Error><Code>InternalError</Code></Error>".into()),
        )
        .build();
    let abort = mock!(Client::abort_multipart_upload)
        .then_output(|| AbortMultipartUploadOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);

    let (_dir, path) = small_src_file().await;
    let result = cache.upload_template("abc", &path, true).await;

    assert!(matches!(result, Err(R2Error::S3(_))), "got {result:?}");
    assert!(complete.num_calls() >= 1, "complete was dispatched");
    // abort is the contract under test; exactly one abort is expected
    // even if the SDK retried `complete` internally — r2_cache issues
    // one best-effort abort per failed upload (not per retry).
    assert_eq!(abort.num_calls(), 1, "abort MUST run on Complete failure");
}

/// Dropping the upload future after `CreateMultipartUpload` must not leave
/// server-side multipart state behind until R2 lifecycle cleanup. The guard
/// schedules a detached abort on drop, which is the cancellation path that
/// normal error-return tests do not exercise.
#[tokio::test]
async fn multipart_upload_guard_aborts_on_drop() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;

    let abort = mock!(Client::abort_multipart_upload)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/abc.tar.zst")
                && req.upload_id() == Some("test-upload-id")
        })
        .then_output(|| AbortMultipartUploadOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&abort]);

    drop(MultipartUploadGuard::new(
        cache.client.clone(),
        cache.bucket.clone(),
        key_for_template_hash("abc"),
        "test-upload-id".to_string(),
    ));

    wait_for_rule_calls(&abort, 1).await;
}

/// Missing `e_tag` on `upload_part` response → `R2Error::S3` with the
/// part_number interpolated, so operators can pin a `Complete`-time
/// "InvalidPart" to the specific failed upload without log archaeology.
#[tokio::test]
async fn upload_part_missing_etag_errors_with_part_number() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
    use aws_sdk_s3::operation::complete_multipart_upload::CompleteMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;
    use aws_sdk_s3::operation::upload_part::UploadPartOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    // Response with no `e_tag`: surfaces as pinned error, Complete never
    // runs (pack→stream→complete pipeline short-circuits on upload error).
    let upload_part =
        mock!(Client::upload_part).then_output(|| UploadPartOutput::builder().build());
    let complete = mock!(Client::complete_multipart_upload)
        .then_output(|| CompleteMultipartUploadOutput::builder().build());
    // Abort is best-effort on any error path — include a mock so the SDK
    // dispatch doesn't panic on unmatched.
    let abort = mock!(Client::abort_multipart_upload)
        .then_output(|| AbortMultipartUploadOutput::builder().build());

    let cache = mock_cache("test-bucket", &[&create, &upload_part, &complete, &abort]);

    let (_dir, path) = small_src_file().await;
    let err = cache.upload_template("abc", &path, true).await.unwrap_err();

    match err {
        R2Error::S3(msg) => {
            assert!(
                msg.contains("upload_part 1"),
                "want pinned part_number: {msg}"
            );
            assert!(msg.contains("missing e_tag"), "want missing e_tag: {msg}");
        }
        other => panic!("expected R2Error::S3 with pinned part_number, got {other:?}"),
    }
    assert_eq!(abort.num_calls(), 1, "failed upload must abort once");
    assert_eq!(complete.num_calls(), 0, "failed upload must not complete");
}

#[tokio::test]
async fn upload_missing_template_source_aborts_multipart() {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::abort_multipart_upload::AbortMultipartUploadOutput;
    use aws_sdk_s3::operation::create_multipart_upload::CreateMultipartUploadOutput;

    let create = mock!(Client::create_multipart_upload).then_output(|| {
        CreateMultipartUploadOutput::builder()
            .upload_id("test-upload-id")
            .build()
    });
    let abort = mock!(Client::abort_multipart_upload)
        .then_output(|| AbortMultipartUploadOutput::builder().build());
    let cache = mock_cache("test-bucket", &[&create, &abort]);
    let missing = std::path::Path::new("/definitely/missing/template.ext4");

    let error = cache
        .upload_template("abc", missing, true)
        .await
        .unwrap_err();

    assert!(matches!(error, R2Error::Io(_)));
    assert_eq!(abort.num_calls(), 1);
}
