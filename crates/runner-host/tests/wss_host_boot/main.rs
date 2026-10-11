//! Opt-in, canonical-path filesystem acceptance; see the adjacent README.
#![cfg(target_os = "linux")]

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

use nix::sys::stat::{Mode, umask};
use nix::sys::statfs::statfs;
use nix::unistd::{Group, geteuid};
use runner_host::gc::gc_wss_sockets;
use runner_host::paths::HomePaths;
use runner_host::runner_wss_socket::RunnerWssSocket;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::time::timeout;
use uuid::Uuid;

const HOME: &str = "/var/lib/vm0-runner";
const RECEIPT: &str = ".wss-host-boot.json";

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    name: String,
    inode: u64,
    modified: (i64, i64),
    uid: u32,
    gid: u32,
    mode: u32,
    socket: bool,
    digest: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    boot_id: Uuid,
    executable_sha256: String,
    home_inode: u64,
    namespace_inode: u64,
    recover_id: Uuid,
    retire_id: Uuid,
    unknown_id: Uuid,
    entries: Vec<Entry>,
}

fn refuse(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason)
}

fn group() -> io::Result<u32> {
    let gid = Group::from_name("okou-wss-caddy")?
        .ok_or_else(|| refuse("dedicated WSS group missing"))?
        .gid
        .as_raw();
    if gid == 0 {
        return Err(refuse("dedicated WSS group must differ from root"));
    }
    Ok(gid)
}

/// All mutations use the canonical home, only after proving its isolated mount.
fn isolated_home() -> io::Result<HomePaths> {
    if geteuid().as_raw() != 0 {
        return Err(refuse("fixture requires root"));
    }
    group()?;
    if fs::read_link("/proc/self/ns/mnt")? == fs::read_link("/proc/1/ns/mnt")? {
        return Err(refuse("fixture requires a private mount namespace"));
    }
    let source = PathBuf::from(
        std::env::var_os("OKOU_TEST_WSS_BOOT_HOME")
            .ok_or_else(|| refuse("explicit disposable backing home required"))?,
    );
    let home = Path::new(HOME);
    if !source.is_absolute()
        || fs::canonicalize(&source)? != source
        || source.starts_with(home)
        || home.starts_with(&source)
    {
        return Err(refuse(
            "backing home must be a separate canonical directory",
        ));
    }
    for ancestor in source.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)?;
        if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
            return Err(refuse(
                "backing home ancestors must be root-owned and not writable",
            ));
        }
    }
    let backing = fs::symlink_metadata(&source)?;
    let mounted = fs::symlink_metadata(home)?;
    for metadata in [&backing, &mounted] {
        if !metadata.is_dir()
            || metadata.uid() != 0
            || metadata.gid() != 0
            || metadata.mode() & 0o7777 != 0o755
        {
            return Err(refuse(
                "fixture home must be a real root:root 0755 directory",
            ));
        }
    }
    if (backing.dev(), backing.ino()) != (mounted.dev(), mounted.ino()) {
        return Err(refuse("canonical home is not the supplied backing inode"));
    }
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")?;
    let mount = mountinfo
        .lines()
        .find(|line| line.split_whitespace().nth(4) == Some(HOME))
        .ok_or_else(|| refuse("canonical home must be an explicit bind mount"))?;
    if mount
        .split_whitespace()
        .take_while(|field| *field != "-")
        .any(|field| field.starts_with("shared:"))
    {
        return Err(refuse(
            "fixture mount must not propagate to other namespaces",
        ));
    }
    // The documented fixture uses an explicitly persistent ext4 test volume.
    if statfs(&source)?.filesystem_type().0 != libc::EXT4_SUPER_MAGIC {
        return Err(refuse("fixture requires a persistent ext4 backing volume"));
    }
    HomePaths::new().map_err(io::Error::other)
}

fn boot_id() -> io::Result<Uuid> {
    Uuid::parse_str(fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim())
        .map_err(io::Error::other)
}

fn digest(path: &Path) -> io::Result<String> {
    Ok(hex::encode(Sha256::digest(fs::read(path)?)))
}

fn namespace(home: &HomePaths) -> io::Result<u64> {
    let metadata = fs::symlink_metadata(home.wss_dir())?;
    if !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.gid() != group()?
        || metadata.mode() & 0o7777 != 0o710
    {
        return Err(refuse("WSS namespace must be root:dedicated-group 0710"));
    }
    Ok(metadata.ino())
}

fn entries(home: &HomePaths) -> io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for item in fs::read_dir(home.wss_dir())? {
        let path = item?.path();
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| refuse("invalid fixture filename"))?
            .to_owned();
        let metadata = fs::symlink_metadata(&path)?;
        let socket = metadata.file_type().is_socket();
        if metadata.uid() != 0
            || (socket && (metadata.gid() != group()? || metadata.mode() & 0o7777 != 0o660))
            || (!socket && (!metadata.is_file() || metadata.mode() & 0o7777 != 0o600))
            || (!socket && metadata.len() > 1024)
        {
            return Err(refuse(
                "unexpected WSS fixture artifact type/owner/permissions",
            ));
        }
        entries.push(Entry {
            name,
            inode: metadata.ino(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            uid: metadata.uid(),
            gid: metadata.gid(),
            mode: metadata.mode() & 0o7777,
            socket,
            digest: if socket { None } else { Some(digest(&path)?) },
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

async fn exchange(socket: &RunnerWssSocket, home: &HomePaths, id: Uuid) -> io::Result<()> {
    timeout(Duration::from_secs(10), async {
        let mut client = UnixStream::connect(home.wss_dir().join(format!("{id}.sock"))).await?;
        let mut server = socket.accept().await?;
        client.write_all(b"boot-probe").await?;
        let mut request = [0; 10];
        server.read_exact(&mut request).await?;
        assert_eq!(&request, b"boot-probe");
        server.write_all(b"accepted").await?;
        let mut response = [0; 8];
        client.read_exact(&mut response).await?;
        assert_eq!(&response, b"accepted");
        io::Result::Ok(())
    })
    .await?
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires an isolated persistent home; deliberately holds sockets until authorized reboot"]
async fn prepare_wss_state_for_host_boot() -> io::Result<()> {
    let home = isolated_home()?;
    if fs::read_dir(HOME)?.next().is_some() {
        return Err(refuse("preparation requires a new empty disposable home"));
    }
    // Production creation must establish exact permissions even under umask0777.
    umask(Mode::all());
    let recover_id = Uuid::new_v4();
    let retire_id = Uuid::new_v4();
    let unknown_id = Uuid::new_v4();
    let first = RunnerWssSocket::bind(&home.wss_dir(), recover_id)?;
    let second = RunnerWssSocket::bind(&home.wss_dir(), retire_id)?;
    exchange(&first, &home, recover_id).await?;
    exchange(&second, &home, retire_id).await?;
    let unknown_path = home.wss_dir().join(format!("{unknown_id}.sock"));
    let unknown = UnixListener::bind(&unknown_path)?;
    nix::unistd::chown(
        &unknown_path,
        None,
        Some(nix::unistd::Gid::from_raw(group()?)),
    )?;
    fs::set_permissions(&unknown_path, fs::Permissions::from_mode(0o660))?;
    let receipt = Receipt {
        version: 1,
        boot_id: boot_id()?,
        executable_sha256: digest(&std::env::current_exe()?)?,
        home_inode: fs::symlink_metadata(HOME)?.ino(),
        namespace_inode: namespace(&home)?,
        recover_id,
        retire_id,
        unknown_id,
        entries: entries(&home)?,
    };
    assert_eq!(receipt.entries.len(), 9);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(Path::new(HOME).join(RECEIPT))?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    serde_json::to_writer(&mut file, &receipt)?;
    file.sync_all()?;
    File::open(home.wss_dir())?.sync_all()?;
    File::open(HOME)?.sync_all()?;
    println!(
        "WSS_HOST_BOOT_PREPARED boot_id={} binary_sha256={} recover_id={} retire_id={} unknown_id={}",
        receipt.boot_id, receipt.executable_sha256, recover_id, retire_id, unknown_id
    );
    io::stdout().flush()?;
    std::future::pending::<()>().await;
    drop((first, second, unknown));
    Err(io::Error::other(
        "pre-boot holder must end at the authorized boot",
    ))
}

fn receipt() -> io::Result<Receipt> {
    let path = Path::new(HOME).join(RECEIPT);
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o7777 != 0o600
        || metadata.len() > 32768
    {
        return Err(refuse("unsafe fixture receipt"));
    }
    serde_json::from_slice(&fs::read(path)?).map_err(io::Error::other)
}

async fn verify_recovery(home: &HomePaths, receipt: Receipt) -> io::Result<()> {
    assert_eq!(receipt.version, 1);
    assert_eq!(
        receipt.executable_sha256,
        digest(&std::env::current_exe()?)?
    );
    assert_eq!(receipt.home_inode, fs::symlink_metadata(HOME)?.ino());
    assert_eq!(receipt.namespace_inode, namespace(home)?);
    // Mount-local device IDs deliberately do not enter persistent evidence.
    assert_eq!(receipt.entries, entries(home)?);
    let unknown_name = format!("{}.sock", receipt.unknown_id);
    let unknown = receipt
        .entries
        .into_iter()
        .find(|entry| entry.name == unknown_name)
        .ok_or_else(|| refuse("unknown endpoint absent from receipt"))?;
    let live = RunnerWssSocket::bind(&home.wss_dir(), receipt.recover_id)?;
    exchange(&live, home, receipt.recover_id).await?;
    let collision = RunnerWssSocket::bind(&home.wss_dir(), receipt.recover_id);
    assert_eq!(
        collision.err().and_then(|error| error.raw_os_error()),
        Some(libc::EWOULDBLOCK)
    );
    assert_eq!(gc_wss_sockets(home, true)?, 1);
    assert_eq!(gc_wss_sockets(home, false)?, 1);
    assert_eq!(gc_wss_sockets(home, false)?, 0);
    exchange(&live, home, receipt.recover_id).await?;
    for suffix in ["sock", "lock", "owner"] {
        assert!(
            !home
                .wss_dir()
                .join(format!("{}.{suffix}", receipt.retire_id))
                .try_exists()?
        );
    }
    drop(live);
    assert_eq!(entries(home)?, vec![unknown]);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires retained state from prepare and a real authorized host boot"]
async fn verify_wss_state_after_host_boot() -> io::Result<()> {
    let home = isolated_home()?;
    let receipt = receipt()?;
    let current_boot = boot_id()?;
    if receipt.boot_id == current_boot {
        return Err(refuse(
            "host boot ID unchanged; process restart is not host-boot evidence",
        ));
    }
    let previous_boot = receipt.boot_id;
    verify_recovery(&home, receipt).await?;
    println!("WSS_HOST_BOOT_VERIFIED previous_boot={previous_boot} current_boot={current_boot}");
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "process-kill rehearsal only; does not supply host-boot evidence"]
async fn rehearse_wss_recovery_after_process_death() -> io::Result<()> {
    let home = isolated_home()?;
    let receipt = receipt()?;
    assert_eq!(receipt.boot_id, boot_id()?);
    verify_recovery(&home, receipt).await?;
    println!("WSS_PROCESS_CRASH_REHEARSAL_ONLY; physical host-boot acceptance remains unverified");
    Ok(())
}
