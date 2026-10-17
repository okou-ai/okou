//! Actual regular-file reads through the admitted role on both pinned kernels.
use super::{
    TestResult,
    duplex::{receive, send},
    filesystem::command,
};
use api_contracts::generated::types::sandbox_channel::fs_read;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use guest_contracts::sandbox_channel::{Message, Operation, ResultPayload, decode_result};
use runner_remote::guest_duplex::Channel;
use sandbox::Sandbox;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io, time::Duration};

async fn call(
    channel: &mut Channel,
    operation: &str,
    params: Value,
) -> TestResult<Result<Value, String>> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let id = uuid::Uuid::new_v4().to_string();
        send(channel, json!({"schemaVersion":1,"type":"request","id":id,"category":"fs","categoryVersion":3,"operation":operation,"params":params})).await?;
        match receive(channel).await? {
            Message::Response { request_id, result:Some(value), error:None, .. } if request_id == id => Ok(Ok(value)),
            Message::Response { request_id, result:None, error:Some(error), .. } if request_id == id => Ok(Err(error.code)),
            _ => Err(io::Error::other("unowned native file-read response").into()),
        }
    }).await?
}

fn path(root: &str, suffix: &str) -> Vec<String> {
    format!("{root}/{suffix}")
        .trim_start_matches('/')
        .split('/')
        .map(|s| URL_SAFE_NO_PAD.encode(s))
        .collect()
}

async fn open(
    channel: &mut Channel,
    path: Vec<String>,
    mode: &str,
) -> TestResult<fs_read::OpenResult> {
    let value = call(channel, "open", json!({"path":path,"mode":mode}))
        .await?
        .map_err(|_| io::Error::other("native regular-file open rejected"))?;
    match decode_result(Operation::FsReadOpen, value)? {
        ResultPayload::FsReadOpen(value) => Ok(value),
        _ => Err(io::Error::other("invalid native file metadata").into()),
    }
}

async fn read(channel: &mut Channel, handle: &str, offset: u64) -> TestResult<fs_read::ReadResult> {
    let value = call(
        channel,
        "read",
        json!({"handle":handle,"offset":offset.to_string(),"length":32768}),
    )
    .await?
    .map_err(|_| io::Error::other("native file read rejected"))?;
    match decode_result(Operation::FsRead, value)? {
        ResultPayload::FsRead(value) if value.offset == offset.to_string() => Ok(value),
        _ => Err(io::Error::other("invalid native chunk result").into()),
    }
}

async fn release(channel: &mut Channel, operation: &str, handle: &str) -> TestResult<()> {
    let value = call(channel, operation, json!({"handle":handle}))
        .await?
        .map_err(|_| io::Error::other("native reader release rejected"))?;
    decode_result(
        if operation == "finish" {
            Operation::FsReadFinish
        } else {
            Operation::FsReadClose
        },
        value,
    )?;
    reject_handle(channel, handle).await
}

pub(super) async fn reject_handle(channel: &mut Channel, handle: &str) -> TestResult<()> {
    if call(
        channel,
        "read",
        json!({"handle":handle,"offset":"0","length":1}),
    )
    .await?
        != Err("handle_expired".into())
    {
        return Err(
            io::Error::other("foreign or retired reader survived its connection epoch").into(),
        );
    }
    Ok(())
}

pub(super) async fn exercise(
    sandbox: &dyn Sandbox,
    channel: &mut Channel,
    idle: &mut Channel,
    root: &str,
) -> TestResult<String> {
    command(sandbox, &format!(
        "set -eu\npython3 -c 'from pathlib import Path; p=Path(\"{root}/nested/leaf\"); p.write_bytes(bytes(i % 256 for i in range(70003))); f=open(\"{root}/nested/sparse\",\"wb\"); f.seek(4294967313); f.write(b\"tail\"); f.close()'\nmkfifo '{root}/nested/pipe'\nmknod '{root}/nested/device' c 1 3\nprintf denied > '{root}/mount/file'"
    ),true).await?;
    let expected: Vec<u8> = (0..70_003).map(|n| (n % 256) as u8).collect();
    let full = open(channel, path(root, "nested/leaf"), "download").await?;
    if full.file_size != "70003" || full.selected_size != full.file_size || full.truncated {
        return Err(io::Error::other("native complete download selection mismatch").into());
    }
    let mut hash = Sha256::new();
    let mut offset = 0_u64;
    while offset < 70_003 {
        let result = read(channel, &full.handle, offset).await?;
        let bytes = STANDARD.decode(result.data)?;
        let start = usize::try_from(offset)?;
        let end = expected.len().min(start + 32768);
        if bytes
            != expected
                .get(start..end)
                .ok_or_else(|| io::Error::other("native fixture range mismatch"))?
            || result.length != bytes.len() as u64
        {
            return Err(io::Error::other("native file chunk bytes/length mismatch").into());
        }
        hash.update(&bytes);
        offset += bytes.len() as u64;
    }
    if hash.finalize() != Sha256::digest(&expected) {
        return Err(io::Error::other("native complete file hash mismatch").into());
    }
    release(channel, "finish", &full.handle).await?;
    let prefix = open(channel, path(root, "nested/leaf"), "prefix").await?;
    if prefix.selected_size != "65536" || !prefix.truncated {
        return Err(io::Error::other("native prefix selection mismatch").into());
    }
    if read(channel, &prefix.handle, 65535).await?.length != 1 {
        return Err(io::Error::other("native prefix read crossed its selected range").into());
    }
    release(channel, "close", &prefix.handle).await?;
    let empty = open(channel, path(root, ".hidden"), "preview").await?;
    if empty.file_size != "0" || read(channel, &empty.handle, 0).await?.length != 0 {
        return Err(io::Error::other("native empty file mismatch").into());
    }
    release(channel, "finish", &empty.handle).await?;
    if call(
        channel,
        "open",
        json!({"path":path(root,"nested/sparse"),"mode":"preview"}),
    )
    .await?
        != Err("limit_exceeded".into())
    {
        return Err(io::Error::other("native preview limit missing").into());
    }
    let large = open(channel, path(root, "nested/sparse"), "download").await?;
    if large.file_size != "4294967317"
        || large.selected_size != large.file_size
        || STANDARD.decode(read(channel, &large.handle, 4294967313).await?.data)? != b"tail"
    {
        return Err(io::Error::other("native offset beyond four GiB was truncated").into());
    }
    release(channel, "finish", &large.handle).await?;
    for (suffix, code) in [
        ("outside", "link_not_expandable"),
        ("nested/pipe", "not_regular_file"),
        ("nested/device", "not_regular_file"),
        ("mount/file", "mount_not_expandable"),
    ] {
        if call(
            channel,
            "open",
            json!({"path":path(root,suffix),"mode":"download"}),
        )
        .await?
            != Err(code.into())
        {
            return Err(io::Error::other("native file containment/type policy mismatch").into());
        }
    }
    let changed = open(channel, path(root, "nested/leaf"), "download").await?;
    command(
        sandbox,
        &format!("printf changed > '{root}/nested/leaf'"),
        true,
    )
    .await?;
    if call(
        channel,
        "read",
        json!({"handle":changed.handle,"offset":"0","length":1}),
    )
    .await?
        != Err("file_changed".into())
    {
        return Err(io::Error::other("native file mutation was not rejected").into());
    }
    reject_handle(channel, &changed.handle).await?;
    let changed = open(channel, path(root, "nested/leaf"), "download").await?;
    command(
        sandbox,
        &format!("printf changed-again > '{root}/nested/leaf'"),
        true,
    )
    .await?;
    if call(channel, "finish", json!({"handle":changed.handle})).await?
        != Err("file_changed".into())
    {
        return Err(io::Error::other("native final file validation missed mutation").into());
    }
    for replacement in ["ln -s /etc/passwd", "mkfifo", "mknod"] {
        let changed = open(channel, path(root, "nested/leaf"), "download").await?;
        let arguments = if replacement == "mknod" { " c 1 3" } else { "" };
        command(
            sandbox,
            &format!(
                "set -eu\nrm '{root}/nested/leaf'\n{replacement} '{root}/nested/leaf'{arguments}"
            ),
            true,
        )
        .await?;
        if call(
            channel,
            "read",
            json!({"handle":changed.handle,"offset":"0","length":1}),
        )
        .await?
            != Err("file_changed".into())
        {
            return Err(io::Error::other("native terminal replacement was not rejected").into());
        }
        reject_handle(channel, &changed.handle).await?;
        command(
            sandbox,
            &format!("set -eu\nrm '{root}/nested/leaf'\nprintf restored > '{root}/nested/leaf'"),
            true,
        )
        .await?;
    }
    let retained = open(idle, path(root, "nested/leaf"), "download").await?;
    reject_handle(channel, &retained.handle).await?;
    println!(
        "FILE_READ_FIRECRACKER_PASS arch={} fs=3 bytes=70003 hash=exact offset=above-4GiB preview=bounded download=uncapped mutation=rejected special=rejected close=owned",
        std::env::consts::ARCH
    );
    Ok(retained.handle)
}
