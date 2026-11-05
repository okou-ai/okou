use aws_smithy_mocks::{Rule, mock};

/// Mock-rule factory for the happy-path multipart triad.
/// Returns (create, upload_part, complete) rules. Caller wires them with
/// any head_object rule needed by the specific test.
pub fn multipart_success_rules() -> (Rule, Rule, Rule) {
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
