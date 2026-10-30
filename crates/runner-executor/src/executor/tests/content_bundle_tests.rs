use std::{fs, io::Write, path::Path, sync::Arc, time::Duration};

use guest_contracts::content_bundle::BundleApplication;
use guest_control_client::{ExecCaptureRequest, WriteFileEntry};
use guest_control_proto::{ExecCapturedOutput, ExecTermination};
use sandbox::SandboxId;
use sandbox_mock::{ExecCall, MockSandboxFactory, MockSandboxOverrides, WriteFileCall};
use sha2::{Digest, Sha256};
use tokio::net::UnixStream;
use tokio_util::sync::CancellationToken;

use super::super::{NewSandboxDispatch, execute_job};
use super::support::{default_params, minimal_context, test_executor_config_with_startup_api};
use crate::test_fixtures::guest_control::{read_frame, send_frame};
use runner_types::types::SandboxReuseResult;

/// Replay the exact archive and exec request produced by Runner through the real
/// client, wire codec and socket. Only the Guest filesystem root is remapped.
async fn install_over_guest_control(
    file: &WriteFileCall,
    exec: &ExecCall,
    home: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let runtime = home.join("private");
    fs::create_dir(&runtime)?;
    let source = runtime.join(
        Path::new(&file.path)
            .file_name()
            .ok_or("missing archive filename")?,
    );
    let (host, mut guest) = UnixStream::pair()?;
    let handshake = async {
        send_frame(&mut guest, guest_control_proto::MSG_READY, 0, &[]).await;
        let ping = read_frame(&mut guest).await;
        assert_eq!(ping.msg_type, guest_control_proto::MSG_PING);
        send_frame(&mut guest, guest_control_proto::MSG_PONG, ping.seq, &[]).await;
    };
    let (client, ()) = tokio::join!(
        guest_control_client::test_support::from_stream(host, Duration::from_secs(5)),
        handshake,
    );
    let client = client?;
    let send = async {
        client
            .write_private_files(&[WriteFileEntry {
                path: &file.path,
                content: &file.content,
            }])
            .await?;
        let result = client
            .exec_operation_capture(ExecCaptureRequest {
                timeout_ms: 5_000,
                command: &exec.cmd,
                env: &[],
                sudo: exec.sudo,
                label: "content-bundle",
                stdout_limit_bytes: 1024,
                stderr_limit_bytes: 1024,
                expected_exit_codes: &[],
                stdin_bytes: exec.stdin_bytes.as_deref(),
                wait_timeout: Duration::from_secs(5),
            })
            .await?;
        assert_eq!(result.termination, ExecTermination::Exited { exit_code: 0 });
        Ok::<(), Box<dyn std::error::Error>>(())
    };
    let receive = async {
        let mut chunks = 0;
        loop {
            let frame = read_frame(&mut guest).await;
            if frame.msg_type == guest_control_proto::MSG_WRITE_FILE {
                let (path, content, sudo, append, private) =
                    guest_control_proto::decode_write_file(&frame.payload)?;
                assert_eq!(path, file.path);
                assert!(private && !sudo);
                assert_eq!(append, chunks > 0);
                fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(!append)
                    .append(append)
                    .open(&source)?
                    .write_all(content)?;
                chunks += 1;
                send_frame(
                    &mut guest,
                    guest_control_proto::MSG_WRITE_FILE_RESULT,
                    frame.seq,
                    &guest_control_proto::encode_write_file_result(true, ""),
                )
                .await;
                continue;
            }
            assert_eq!(frame.msg_type, guest_control_proto::MSG_EXEC_START);
            assert!(
                chunks >= 2,
                "large archive must use the private chunked transport"
            );
            let request = guest_control_proto::decode_exec_start(&frame.payload)?;
            let metadata = request.stdin_bytes.ok_or("missing bundle metadata")?;
            assert!(metadata.len() < guest_contracts::content_bundle::MAX_METADATA_BYTES);
            let mut input: BundleApplication = serde_json::from_slice(metadata)?;
            let BundleApplication::Skill { mount, archive } = &mut input else {
                return Err("expected skill archive".into());
            };
            *mount = home
                .join(Path::new(mount).strip_prefix("/home/user")?)
                .to_str()
                .ok_or("fixture mount is not UTF-8")?
                .into();
            assert_eq!(archive.source, file.path);
            archive.source = source.to_str().ok_or("fixture source is not UTF-8")?.into();
            assert!(guest_storage_apply::apply_content_bundle(
                home,
                &runtime,
                &serde_json::to_vec(&input)?,
            ));
            let result = guest_control_proto::encode_exec_result(
                ExecTermination::Exited { exit_code: 0 },
                0,
                ExecCapturedOutput::Captured {
                    bytes: &[],
                    truncated: false,
                },
                ExecCapturedOutput::Captured {
                    bytes: &[],
                    truncated: false,
                },
                "",
            )?;
            send_frame(
                &mut guest,
                guest_control_proto::MSG_EXEC_RESULT,
                frame.seq,
                &result,
            )
            .await;
            break;
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    };
    let (sent, received) = tokio::time::timeout(Duration::from_secs(30), async {
        tokio::join!(send, receive)
    })
    .await?;
    sent?;
    received?;
    Ok(())
}

#[tokio::test]
async fn cached_many_file_archive_crosses_real_guest_rpc_and_installs_complete_skill() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::none());
    let mut tar = tar::Builder::new(encoder);
    let paths = std::iter::once("SKILL.md".into())
        .chain((0..500).map(|index| {
            format!(
                "references/{0}/{0}/{0}/{index:03}.bin",
                "long-path-".repeat(6)
            )
        }))
        .collect::<Vec<_>>();
    let content = (0..32 * 1024).map(|i| (i % 251) as u8).collect::<Vec<_>>();
    for path in &paths {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o600);
        header.set_size(content.len() as u64);
        header.set_cksum();
        tar.append_data(&mut header, path, content.as_slice())
            .unwrap();
    }
    let archive = tar.into_inner().unwrap().finish().unwrap();
    assert!(archive.len() > 15 * 1024 * 1024);
    let hash = hex::encode(Sha256::digest(&archive));
    fs::create_dir_all(config.home.bundles_dir()).unwrap();
    fs::write(
        config.home.bundles_dir().join(format!("{hash}.tar.gz")),
        &archive,
    )
    .unwrap();
    let mut context = minimal_context();
    context.content_bundles = Some(
        serde_json::from_value(serde_json::json!({
            "format": "tar-gzip-v1", "skills": [{
                "sha256": hash, "archiveBytes": archive.len(),
                "downloadUrl": "https://unreachable.invalid/cached",
                "mountPath": "/home/user/.codex/skills/example",
            }],
        }))
        .unwrap(),
    );
    let overrides = Arc::new(MockSandboxOverrides::new());
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (mut outcome, _) = execute_job(
        &factory,
        context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(outcome.exit_code(), 0, "{:?}", outcome.error());
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
    let writes = overrides.private_write_files_calls();
    let file = writes
        .iter()
        .flat_map(|call| &call.files)
        .find(|file| file.content == archive)
        .unwrap();
    let calls = overrides.exec_calls();
    let exec = calls
        .iter()
        .find(|call| call.cmd.ends_with(" --bundle-stdin"))
        .unwrap();
    let guest = tempfile::tempdir().unwrap();
    install_over_guest_control(file, exec, guest.path())
        .await
        .unwrap();
    for path in paths {
        assert_eq!(
            fs::read(guest.path().join(".codex/skills/example").join(path)).unwrap(),
            content
        );
    }
}

#[tokio::test]
async fn failed_bundle_installation_prevents_agent_spawn() {
    let directory = tempfile::tempdir().unwrap();
    let (config, _api) = test_executor_config_with_startup_api(directory.path()).await;
    let archive = include_bytes!("../../../tests/fixtures/content-bundle-v1.tar.gz");
    let hash = hex::encode(Sha256::digest(archive));
    fs::create_dir_all(config.home.bundles_dir()).unwrap();
    fs::write(
        config.home.bundles_dir().join(format!("{hash}.tar.gz")),
        archive,
    )
    .unwrap();
    let mut context = minimal_context();
    context.content_bundles = Some(
        serde_json::from_value(serde_json::json!({
            "format": "tar-gzip-v1", "skills": [{
                "sha256": hash, "archiveBytes": archive.len(),
                "downloadUrl": "https://unreachable.invalid/cached",
                "mountPath": "/home/user/.codex/skills/example",
            }],
        }))
        .unwrap(),
    );
    let overrides = Arc::new(MockSandboxOverrides::new());
    overrides.add_exec_result_matcher(
        " --bundle-stdin",
        sandbox::ExecResult::new(1, Vec::new(), Vec::new()),
    );
    let factory = MockSandboxFactory::with_overrides(Arc::clone(&overrides));
    let (mut outcome, _) = execute_job(
        &factory,
        context,
        NewSandboxDispatch {
            id: SandboxId::new_v4(),
            reuse_result: SandboxReuseResult::NoReuseKey,
        },
        &config,
        &default_params(),
        CancellationToken::new(),
    )
    .await;
    if let Some(report) = outcome.startup_report.take() {
        report.finish().await;
    }
    assert_ne!(outcome.exit_code(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!outcome.sandbox_reuse_disposition.is_eligible());
}
