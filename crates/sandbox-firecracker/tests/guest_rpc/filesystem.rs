//! Real pinned-kernel filesystem role over the same admitted native channel.

use std::{collections::BTreeSet, io, time::Duration};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use guest_contracts::sandbox_channel::{Message, Operation, ResultPayload, decode_result};
use runner_remote::guest_duplex::Channel;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, ExecTermination, Sandbox};
use serde_json::{Value, json};

use super::{
    TestResult,
    duplex::{receive, send},
};

pub(super) async fn exercise(
    sandbox: &dyn Sandbox,
    channel: &mut Channel,
    idle: &mut Channel,
) -> TestResult<String> {
    let name = format!("channel-fs-{}", uuid::Uuid::new_v4());
    let root = format!("/home/user/{name}");
    // This exact owned subtree is removed, including its mount, on every outcome.
    let prepared = command(sandbox, &format!(
        "set -eu\nmkdir -p '{root}/nested' '{root}/mount'\ntouch '{root}/.hidden' '{root}/nested/leaf'\nln -s / '{root}/outside'\nln -s cycle '{root}/cycle'\ni=0; while [ \"$i\" -lt 300 ]; do touch \"{root}/file-$i\"; i=$((i+1)); done\nmount -t tmpfs -o size=1m tmpfs '{root}/mount'"
    ), true).await;
    let result = match prepared {
        Ok(()) => browse(channel, idle, &name).await,
        Err(error) => Err(error),
    };
    let cleanup = command(sandbox, &format!("set -eu\nif mountpoint -q '{root}/mount'; then umount '{root}/mount'; fi\nrm -rf -- '{root}'"), true).await;
    let cursor = result?;
    cleanup?;
    println!(
        "FILESYSTEM_FIRECRACKER_PASS arch={} fs=2 policy=openat2-beneath-no-links-no-xdev root=actual home=canonical-mount paging=complete cursor-close=owned other-mount=rejected cleanup=owned",
        std::env::consts::ARCH
    );
    Ok(cursor)
}

async fn command(sandbox: &dyn Sandbox, command: &str, sudo: bool) -> TestResult<()> {
    let output = sandbox
        .exec(&ExecRequest {
            cmd: command,
            timeout: Duration::from_secs(15),
            env: &[],
            sudo,
            expected_exit_codes: &[],
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await?;
    if !matches!(output.termination, ExecTermination::Exited { exit_code: 0 })
        || output.stdout_truncated
        || output.stderr_truncated
    {
        return Err(io::Error::other("owned Guest filesystem fixture command failed").into());
    }
    Ok(())
}

async fn call(
    channel: &mut Channel,
    operation: &str,
    params: Value,
) -> TestResult<Result<Value, String>> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let id = uuid::Uuid::new_v4().to_string();
        send(channel, json!({"schemaVersion":1,"type":"request","id":id,"category":"fs","categoryVersion":2,"operation":operation,"params":params})).await?;
        match receive(channel).await? {
            Message::Response { request_id, result:Some(result), error:None, .. } if request_id == id => Ok(Ok(result)),
            Message::Response { request_id, result:None, error:Some(error), .. } if request_id == id => Ok(Err(error.code)),
            _ => Err(io::Error::other("unowned native fs response").into()),
        }
    }).await?
}

async fn list(
    channel: &mut Channel,
    params: Value,
) -> TestResult<api_contracts::generated::types::sandbox_channel::fs::ListResult> {
    let value = call(channel, "list", params)
        .await?
        .map_err(|_| io::Error::other("native home listing rejected"))?;
    match decode_result(Operation::FsList, value)? {
        ResultPayload::FsList(page) => Ok(page),
        _ => Err(io::Error::other("invalid native fs role result").into()),
    }
}

async fn browse(channel: &mut Channel, idle: &mut Channel, name: &str) -> TestResult<String> {
    let token = |name: &str| URL_SAFE_NO_PAD.encode(name);
    for (path, expected) in [(vec![], "home"), (vec![token("home")], "user")] {
        let page = list(channel, json!({"path":path})).await?;
        if !page
            .entries
            .iter()
            .any(|entry| entry.name_token == token(expected))
        {
            return Err(io::Error::other("actual Guest ancestor missing").into());
        }
        if let Some(cursor) = page.next_cursor {
            call(channel, "list.close", json!({"cursor":cursor}))
                .await?
                .map_err(|_| io::Error::other("ancestor cursor close failed"))?;
        }
    }
    let mut home = list(channel, json!({"path":[token("home"),token("user")]})).await?;
    let mut found = false;
    for _ in 0..32 {
        found = home
            .entries
            .iter()
            .any(|entry| entry.name_token == token(name));
        if found {
            if let Some(cursor) = home.next_cursor {
                call(channel, "list.close", json!({"cursor":cursor}))
                    .await?
                    .map_err(|_| io::Error::other("home cursor close failed"))?;
            }
            break;
        }
        let Some(cursor) = home.next_cursor else {
            break;
        };
        home = list(channel, json!({"cursor":cursor})).await?;
    }
    if !found {
        return Err(io::Error::other("actual Guest home fixture missing").into());
    }
    let path = vec![token("home"), token("user"), token(name)];
    let mut page = list(channel, json!({"path":path})).await?;
    let listing = page.listing_id.clone();
    let abandoned = page
        .next_cursor
        .clone()
        .ok_or_else(|| io::Error::other("native paging fixture did not continue"))?;
    let mut entries = BTreeSet::new();
    let mut pages = 0;
    loop {
        if page.listing_id != listing {
            return Err(io::Error::other("native listing identity changed").into());
        }
        for entry in page.entries {
            if !entries.insert(entry.name_token) {
                return Err(io::Error::other("native listing repeated an entry").into());
            }
        }
        pages += 1;
        let Some(cursor) = page.next_cursor else {
            break;
        };
        if pages > 8 {
            return Err(io::Error::other("native listing failed its bound").into());
        }
        page = list(channel, json!({"cursor":cursor})).await?;
    }
    if entries.len() != 305 || pages < 3 || !entries.contains(&token(".hidden")) {
        return Err(io::Error::other("native directory silently lost entries").into());
    }
    let nested = list(
        channel,
        json!({"path":[token("home"),token("user"),token(name),token("nested")]}),
    )
    .await?;
    if nested.entries.len() != 1
        || !nested
            .entries
            .first()
            .is_some_and(|entry| entry.name_token == token("leaf"))
        || nested.next_cursor.is_some()
    {
        return Err(io::Error::other("native nested listing mismatch").into());
    }
    for (component, code) in [
        ("outside", "link_not_expandable"),
        ("cycle", "link_not_expandable"),
        ("mount", "mount_not_expandable"),
    ] {
        if call(
            channel,
            "list",
            json!({"path":[token("home"),token("user"),token(name),token(component)]}),
        )
        .await?
            != Err(code.to_owned())
        {
            return Err(io::Error::other("pinned Guest containment policy mismatch").into());
        }
    }
    if call(channel, "list", json!({"cursor":abandoned})).await? != Err("cursor_expired".into()) {
        return Err(io::Error::other("EOF retained a native cursor").into());
    }
    let cursor = list(
        channel,
        json!({"path":[token("home"),token("user"),token(name)]}),
    )
    .await?
    .next_cursor
    .ok_or_else(|| io::Error::other("missing owned cursor"))?;
    let close = call(channel, "list.close", json!({"cursor":cursor}))
        .await?
        .map_err(|_| io::Error::other("native close rejected"))?;
    decode_result(Operation::FsListClose, close)?;
    if call(channel, "list", json!({"cursor":cursor})).await? != Err("cursor_expired".into()) {
        return Err(io::Error::other("closed native cursor remained readable").into());
    }
    // Leave an actual cursor on the exact stream retained by LiveEpoch. Run
    // retirement/park and provider stop must release it even without more IO.
    let retained = list(
        idle,
        json!({"path":[token("home"),token("user"),token(name)]}),
    )
    .await?
    .next_cursor
    .ok_or_else(|| io::Error::other("missing retained native cursor"))?;
    reject_cursor(channel, &retained).await?;
    Ok(retained)
}

pub(super) async fn reject_cursor(channel: &mut Channel, cursor: &str) -> TestResult<()> {
    if call(channel, "list", json!({"cursor":cursor})).await? != Err("cursor_expired".into()) {
        return Err(
            io::Error::other("foreign or retired cursor reached a replacement owner").into(),
        );
    }
    Ok(())
}
