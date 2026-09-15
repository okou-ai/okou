use super::super::guest::{ResolvedGuest, guest_definitions};
use super::*;
use aws_smithy_mocks::{Rule, RuleMode, mock, mock_client};
use std::sync::Arc;

use crate::test_fixtures::http_body::byte_stream_with_error_after;

pub(super) const TEST_TEMPLATE_DISK_BYTES: u64 = 128 * 1024 * 1024;

#[derive(clap::Parser)]
pub(super) struct TestBuildCli {
    #[command(flatten)]
    pub(super) args: BuildArgs,
}

pub(super) fn build_args() -> Vec<String> {
    let mut args = vec!["runner-build".to_string()];
    for definition in guest_definitions() {
        args.push(format!("--{}", definition.name));
        args.push(format!("/tmp/{}", definition.name));
    }
    args.extend(["--profile".to_string(), "vm0/default".to_string()]);
    args
}

pub(super) fn rootfs_input<'a>(
    home: &'a HomePaths,
    rootfs: &'a RootfsPaths,
    guests: &'a GuestBinaries,
    cache: TemplateCache<'a>,
) -> RootfsBuildInput<'a> {
    RootfsBuildInput {
        template: TemplateInput {
            paths: home,
            template_hash: "test-template-hash",
            cache,
            rootfs_disk_mb: 8192,
        },
        rootfs_paths: rootfs,
        guests,
    }
}

pub(super) fn test_guest_binaries() -> GuestBinaries {
    let temp_dir = tempfile::tempdir().unwrap();
    let guest = temp_dir.path().join("guest");
    std::fs::write(&guest, b"guest").unwrap();
    let entries = guest_definitions()
        .iter()
        .map(|definition| ResolvedGuest {
            definition,
            path: guest.clone(),
        })
        .collect();
    GuestBinaries {
        _temp_dir: temp_dir,
        entries,
    }
}

pub(super) fn template_input<'a>(
    home: &'a HomePaths,
    cache: TemplateCache<'a>,
) -> TemplateInput<'a> {
    TemplateInput {
        paths: home,
        template_hash: "test-template-hash",
        cache,
        rootfs_disk_mb: u32::try_from(TEST_TEMPLATE_DISK_BYTES / 1024 / 1024).unwrap(),
    }
}

pub(super) fn mock_r2_cache(rules: &[&Rule]) -> R2ImageCache {
    let client = mock_client!(aws_sdk_s3, RuleMode::MatchAny, rules);
    R2ImageCache::with_client(client, "test-bucket".to_string())
}

pub(super) async fn fake_rootfs_scripts() -> (RootfsScripts, RootfsScriptDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let work_dir = temp_dir.path().to_path_buf();
    tokio::fs::write(
        work_dir.join("build-template.sh"),
        r#"#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
output_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      output_dir="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$output_dir" ]]; then
  exit 2
fi

mkdir -p "$output_dir"
printf built-template > "$output_dir/template.ext4"
printf called > "$script_dir/build-template-called"
"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        work_dir.join("verify-rootfs.sh"),
        r#"#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
rootfs=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rootfs)
      rootfs="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$rootfs" || ! -f "$rootfs" ]]; then
  exit 2
fi
if [[ "$(head -c 11 "$rootfs")" == "verify-fail" ]]; then
  exit 1
fi

printf called >> "$script_dir/verify-rootfs-called"
"#,
    )
    .await
    .unwrap();
    tokio::fs::write(
        work_dir.join("customize-rootfs.sh"),
        "#!/usr/bin/env bash\n",
    )
    .await
    .unwrap();

    // Cache tests replace the external namespace/build tools with a checked-in
    // launcher. Privileged process regressions use the real supervisor on metal.
    let mut scripts = RootfsScripts::from_temp_dir(temp_dir);
    let work_dir = scripts.path().await.unwrap();
    (scripts, work_dir)
}

pub(super) async fn template_archive_bytes(content: &[u8]) -> Vec<u8> {
    assert!(content.len() <= 512);
    let content = content.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut header = tar::Header::new_gnu();
        header.set_path(TEMPLATE_FILE).unwrap();
        header.set_size(1024);
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_entry_type(tar::EntryType::GNUSparse);
        let gnu = header.as_gnu_mut().unwrap();
        gnu.set_real_size(TEST_TEMPLATE_DISK_BYTES);
        gnu.sparse[0].set_offset(0);
        gnu.sparse[0].set_length(512);
        gnu.sparse[1].set_offset(TEST_TEMPLATE_DISK_BYTES - 512);
        gnu.sparse[1].set_length(512);
        header.set_cksum();

        let mut first_extent = [0u8; 512];
        first_extent[..content.len()].copy_from_slice(&content);
        let mut raw = Vec::with_capacity(512 + 1024 + 1024);
        raw.extend_from_slice(header.as_bytes());
        raw.extend_from_slice(&first_extent);
        raw.extend_from_slice(&[0u8; 512]);
        raw.extend_from_slice(&[0u8; 1024]);

        let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        std::io::Write::write_all(&mut encoder, &raw).unwrap();
        encoder.finish().unwrap()
    })
    .await
    .unwrap()
}

pub(super) async fn empty_template_archive_bytes() -> Vec<u8> {
    tokio::task::spawn_blocking(move || {
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        let mut archive = tar::Builder::new(encoder);
        archive.finish().unwrap();
        let encoder = archive.into_inner().unwrap();
        encoder.finish().unwrap()
    })
    .await
    .unwrap()
}

pub(super) fn template_get_rule(body: Vec<u8>) -> Rule {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;
    use aws_sdk_s3::primitives::ByteStream;

    let body = Arc::new(body);
    let body_for_closure = Arc::clone(&body);
    mock!(Client::get_object)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/test-template-hash.tar.zst")
        })
        .then_output(move || {
            GetObjectOutput::builder()
                .body(ByteStream::from((*body_for_closure).clone()))
                .build()
        })
}

pub(super) fn template_get_body_error_rule(body: Vec<u8>) -> Rule {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectOutput;

    let body = Arc::new(body);
    let body_for_closure = Arc::clone(&body);
    mock!(Client::get_object)
        .match_requests(|req| {
            req.bucket() == Some("test-bucket")
                && req.key() == Some("runner-templates/test-template-hash.tar.zst")
        })
        .then_output(move || {
            GetObjectOutput::builder()
                .body(byte_stream_with_error_after(
                    (*body_for_closure).clone(),
                    std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "injected R2 body transport failure",
                    ),
                ))
                .build()
        })
}

pub(super) fn template_get_miss_rule() -> Rule {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::get_object::GetObjectError;
    use aws_sdk_s3::types::error::NoSuchKey;

    mock!(Client::get_object).then_error(|| GetObjectError::NoSuchKey(NoSuchKey::builder().build()))
}

pub(super) fn template_head_miss_rule() -> Rule {
    use aws_sdk_s3::Client;
    use aws_sdk_s3::operation::head_object::HeadObjectError;
    use aws_sdk_s3::types::error::NotFound;

    mock!(Client::head_object).then_error(|| HeadObjectError::NotFound(NotFound::builder().build()))
}

pub(super) fn multipart_success_rules() -> (Rule, Rule, Rule) {
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
