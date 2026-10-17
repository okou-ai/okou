use super::*;
use crate::ChannelError;
use api_contracts::generated::types::sandbox_channel::fs_read;
use base64::engine::general_purpose::STANDARD;
use std::{ffi::CString, fs::OpenOptions, os::unix::fs::FileExt};

async fn open(
    filesystem: &Filesystem,
    owner: &Arc<Owner>,
    path: &[&[u8]],
    mode: &str,
) -> Result<fs_read::OpenResult, Error> {
    let path: Vec<_> = path.iter().map(|name| token(name)).collect();
    serde_json::from_value(
        request(
            filesystem,
            owner,
            Operation::FsReadOpen,
            json!({"path":path,"mode":mode}),
        )
        .await?,
    )
    .map_err(|_| Error::Unavailable)
}

async fn read(
    filesystem: &Filesystem,
    owner: &Arc<Owner>,
    handle: &str,
    offset: u64,
    length: u32,
) -> Result<fs_read::ReadResult, Error> {
    serde_json::from_value(
        request(
            filesystem,
            owner,
            Operation::FsRead,
            json!({"handle":handle,"offset":offset.to_string(),"length":length}),
        )
        .await?,
    )
    .map_err(|_| Error::Unavailable)
}

async fn wire(peer: &mut PeerFixture, n: u64, operation: &str, params: Value) -> Value {
    peer.send(json!({"schemaVersion":1,"type":"request","id":id(n),"category":"fs","categoryVersion":3,"operation":operation,"params":params})).await;
    let response = peer.receive().await;
    assert_eq!(response["requestId"], id(n));
    response
}

fn fifo(path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).unwrap();
    // SAFETY: the test owns this exact new path and supplies a valid CString.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
}

#[tokio::test]
async fn framed_reader_returns_exact_binary_prefix_empty_bytes_and_releases() {
    let root = tempfile::tempdir().unwrap();
    let bytes: Vec<u8> = (0..70_003).map(|n| (n % 256) as u8).collect();
    std::fs::write(root.path().join("binary"), &bytes).unwrap();
    std::fs::write(root.path().join("empty"), []).unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let mut peer = PeerFixture::new(filesystem.service()).await;
    let opened = wire(
        &mut peer,
        2,
        "open",
        json!({"path":[token(b"binary")],"mode":"download"}),
    )
    .await;
    let file: fs_read::OpenResult = serde_json::from_value(opened["result"].clone()).unwrap();
    assert_eq!(file.file_size, bytes.len().to_string());
    assert_eq!(file.selected_size, file.file_size);
    assert!(!file.truncated);
    // Pipeline arbitrary offsets; correlation, rather than request ordering,
    // selects the original bytes and no shared seek offset exists.
    for (n, offset) in [(3, 32768_u64), (4, 0), (5, 65536)] {
        peer.send(json!({"schemaVersion":1,"type":"request","id":id(n),"category":"fs","categoryVersion":3,"operation":"read","params":{"handle":file.handle,"offset":offset.to_string(),"length":32768}})).await;
    }
    let mut seen = BTreeSet::new();
    for _ in 0..3 {
        let response = peer.receive().await;
        let result: fs_read::ReadResult =
            serde_json::from_value(response["result"].clone()).unwrap();
        let offset = result.offset.parse::<usize>().unwrap();
        assert!(seen.insert(offset));
        assert_eq!(
            STANDARD.decode(result.data).unwrap(),
            bytes[offset..bytes.len().min(offset + 32768)]
        );
    }
    assert_eq!(seen, BTreeSet::from([0, 32768, 65536]));
    assert_eq!(
        wire(&mut peer, 6, "finish", json!({"handle":file.handle})).await["result"],
        json!({})
    );
    assert_eq!(
        wire(
            &mut peer,
            7,
            "read",
            json!({"handle":file.handle,"offset":"0","length":1})
        )
        .await["error"]["code"],
        "handle_expired"
    );
    let prefix = wire(
        &mut peer,
        8,
        "open",
        json!({"path":[token(b"binary")],"mode":"prefix"}),
    )
    .await;
    assert_eq!(prefix["result"]["selectedSize"], "65536");
    assert_eq!(prefix["result"]["truncated"], true);
    let handle = prefix["result"]["handle"].as_str().unwrap();
    assert_eq!(
        wire(
            &mut peer,
            9,
            "read",
            json!({"handle":handle,"offset":"65535","length":32768})
        )
        .await["result"]["length"],
        1
    );
    assert_eq!(
        wire(&mut peer, 10, "close", json!({"handle":handle})).await["result"],
        json!({})
    );
    let empty = wire(
        &mut peer,
        11,
        "open",
        json!({"path":[token(b"empty")],"mode":"preview"}),
    )
    .await;
    assert_eq!(empty["result"]["fileSize"], "0");
    let handle = empty["result"]["handle"].as_str().unwrap();
    assert_eq!(
        wire(
            &mut peer,
            12,
            "read",
            json!({"handle":handle,"offset":"0","length":1})
        )
        .await["result"],
        json!({"offset":"0","length":0,"data":""})
    );
    assert_eq!(
        wire(&mut peer, 13, "finish", json!({"handle":handle})).await["result"],
        json!({})
    );
    peer.close().await;
}

#[tokio::test]
async fn preview_caps_do_not_limit_sparse_downloads_beyond_four_gib() {
    let root = tempfile::tempdir().unwrap();
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.path().join("large"))
        .unwrap();
    let offset = (1_u64 << 32) + 17;
    file.set_len(offset + 4).unwrap();
    file.write_all_at(b"tail", offset).unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let owner = owner(&filesystem);
    assert_eq!(
        open(&filesystem, &owner, &[b"large"], "preview")
            .await
            .unwrap_err(),
        Error::Contract(ChannelError::LimitExceeded)
    );
    let opened = open(&filesystem, &owner, &[b"large"], "download")
        .await
        .unwrap();
    assert_eq!(opened.file_size, (offset + 4).to_string());
    assert_eq!(opened.selected_size, opened.file_size);
    let tail = read(&filesystem, &owner, &opened.handle, offset, 32768)
        .await
        .unwrap();
    assert_eq!(tail.length, 4);
    assert_eq!(STANDARD.decode(tail.data).unwrap(), b"tail");
    request(
        &filesystem,
        &owner,
        Operation::FsReadFinish,
        json!({"handle":opened.handle}),
    )
    .await
    .unwrap();
    let prefix = open(&filesystem, &owner, &[b"large"], "prefix")
        .await
        .unwrap();
    assert_eq!(prefix.selected_size, "65536");
    assert!(prefix.truncated);
    assert_eq!(
        read(&filesystem, &owner, &prefix.handle, 65537, 1)
            .await
            .unwrap_err(),
        Error::Contract(ChannelError::InvalidParams)
    );
    assert_eq!(
        read(&filesystem, &owner, &prefix.handle, 0, 1)
            .await
            .unwrap_err(),
        Error::HandleExpired
    );
}

#[tokio::test]
async fn modification_during_read_and_before_finish_invalidates_the_handle() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file");
    std::fs::write(&path, b"before").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let owner = owner(&filesystem);
    let opened = open(&filesystem, &owner, &[b"file"], "download")
        .await
        .unwrap();
    let changed = path.clone();
    owner.hooks.lock().unwrap().after_read = Some(Box::new(move || {
        std::fs::write(changed, b"modified after read").unwrap()
    }));
    assert_eq!(
        read(&filesystem, &owner, &opened.handle, 0, 6)
            .await
            .unwrap_err(),
        Error::FileChanged
    );
    assert_eq!(
        request(
            &filesystem,
            &owner,
            Operation::FsReadFinish,
            json!({"handle":opened.handle})
        )
        .await
        .unwrap_err(),
        Error::HandleExpired
    );
    let opened = open(&filesystem, &owner, &[b"file"], "download")
        .await
        .unwrap();
    std::fs::write(path, b"changed before finish").unwrap();
    assert_eq!(
        request(
            &filesystem,
            &owner,
            Operation::FsReadFinish,
            json!({"handle":opened.handle})
        )
        .await
        .unwrap_err(),
        Error::FileChanged
    );
}

#[tokio::test]
async fn sibling_activity_is_allowed_but_replaced_ancestors_and_targets_fail() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/file"), b"stable").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let owner = owner(&filesystem);
    let opened = open(&filesystem, &owner, &[b"nested", b"file"], "download")
        .await
        .unwrap();
    std::fs::write(root.path().join("nested/sibling"), b"other").unwrap();
    assert_eq!(
        STANDARD
            .decode(
                read(&filesystem, &owner, &opened.handle, 0, 6)
                    .await
                    .unwrap()
                    .data
            )
            .unwrap(),
        b"stable"
    );
    std::fs::rename(root.path().join("nested"), root.path().join("old")).unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/file"), b"stable").unwrap();
    assert_eq!(
        read(&filesystem, &owner, &opened.handle, 0, 6)
            .await
            .unwrap_err(),
        Error::FileChanged
    );
    let opened = open(&filesystem, &owner, &[b"nested", b"file"], "download")
        .await
        .unwrap();
    std::fs::rename(
        root.path().join("nested/file"),
        root.path().join("nested/replaced"),
    )
    .unwrap();
    std::fs::write(root.path().join("nested/file"), b"stable").unwrap();
    assert_eq!(
        request(
            &filesystem,
            &owner,
            Operation::FsReadFinish,
            json!({"handle":opened.handle})
        )
        .await
        .unwrap_err(),
        Error::FileChanged
    );
}

#[tokio::test]
async fn same_length_writes_and_truncation_fail_before_returning_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file");
    std::fs::write(&path, b"original").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let active = owner(&filesystem);
    let opened = open(&filesystem, &active, &[b"file"], "download")
        .await
        .unwrap();
    std::fs::write(&path, b"modified").unwrap();
    // Force a distinct timestamp as well as preserving the exact byte length;
    // this remains deterministic on filesystems with coarse timestamp clocks.
    std::fs::File::open(&path)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        read(&filesystem, &active, &opened.handle, 0, 8)
            .await
            .unwrap_err(),
        Error::FileChanged
    );
    let opened = open(&filesystem, &active, &[b"file"], "download")
        .await
        .unwrap();
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .set_len(0)
        .unwrap();
    assert_eq!(
        read(&filesystem, &active, &opened.handle, 0, 8)
            .await
            .unwrap_err(),
        Error::FileChanged
    );
}

#[tokio::test]
async fn abandoned_open_response_releases_its_already_opened_descriptor() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file"), b"content").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let active = owner(&filesystem);
    let (entered, started) = oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    active.hooks.lock().unwrap().after_job = Some(Box::new(move || {
        entered.send(()).unwrap();
        blocked.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let params = decode_params(
        Operation::FsReadOpen,
        json!({"path":[token(b"file")],"mode":"download"}),
    )
    .unwrap();
    let observation = filesystem.enqueue(Arc::clone(&active), params).unwrap();
    tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        active
            .state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .readers
            .handles
            .len(),
        1
    );
    drop(observation);
    release.send(()).unwrap();
    let observer = owner(&filesystem);
    maintenance_barrier(&filesystem, &observer).await;
    assert!(
        active
            .state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .readers
            .handles
            .is_empty()
    );
}

#[tokio::test]
async fn special_objects_and_a_terminal_replaced_after_pinning_never_supply_contents() {
    let root = tempfile::tempdir().unwrap();
    symlink("/dev/zero", root.path().join("link")).unwrap();
    fifo(&root.path().join("pipe"));
    let _socket = std::os::unix::net::UnixListener::bind(root.path().join("socket")).unwrap();
    std::fs::create_dir(root.path().join("directory")).unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let owner = owner(&filesystem);
    for (name, expected) in [
        (b"link".as_slice(), Error::LinkNotExpandable),
        (b"pipe", Error::NotRegularFile),
        (b"socket", Error::NotRegularFile),
        (b"directory", Error::NotRegularFile),
    ] {
        assert_eq!(
            open(&filesystem, &owner, &[name], "download")
                .await
                .unwrap_err(),
            expected
        );
    }
    for link in [false, true] {
        let path = root.path().join("race");
        std::fs::write(&path, b"original inode").unwrap();
        owner.hooks.lock().unwrap().after_file_pin = Some(Box::new(move || {
            std::fs::remove_file(&path).unwrap();
            if link {
                symlink("/dev/zero", path).unwrap();
            } else {
                fifo(&path);
            }
        }));
        assert_eq!(
            open(&filesystem, &owner, &[b"race"], "download")
                .await
                .unwrap_err(),
            Error::FileChanged
        );
        std::fs::remove_file(root.path().join("race")).unwrap();
    }
}

#[tokio::test]
async fn raw_names_and_connection_owned_handle_limits_expiry_and_close() {
    let root = tempfile::tempdir().unwrap();
    let raw = b"raw-\xff\n";
    std::fs::write(root.path().join(OsString::from_vec(raw.to_vec())), b"raw").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let first = owner(&filesystem);
    let foreign = owner(&filesystem);
    let mut handles = Vec::new();
    for _ in 0..4 {
        let file = open(&filesystem, &first, &[raw], "download").await.unwrap();
        assert_eq!(file.name_token, token(raw));
        assert!(!file.display_name.chars().any(char::is_control));
        handles.push(file.handle);
    }
    assert_eq!(
        open(&filesystem, &first, &[raw], "download")
            .await
            .unwrap_err(),
        Error::Busy
    );
    assert_eq!(
        read(&filesystem, &foreign, &handles[0], 0, 1)
            .await
            .unwrap_err(),
        Error::HandleExpired
    );
    request(
        &filesystem,
        &first,
        Operation::FsReadClose,
        json!({"handle":handles[0]}),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&filesystem, &first, &handles[0], 0, 1)
            .await
            .unwrap_err(),
        Error::HandleExpired
    );
    let active = open(&filesystem, &first, &[raw], "download").await.unwrap();
    first
        .state
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .readers
        .handles
        .get_mut(&active.handle)
        .unwrap()
        .idle_until = Instant::now();
    maintenance_barrier(&filesystem, &foreign).await;
    assert_eq!(
        read(&filesystem, &first, &active.handle, 0, 1)
            .await
            .unwrap_err(),
        Error::HandleExpired
    );
}

#[tokio::test]
async fn cancelled_read_observers_keep_physical_window_permits_until_retirement() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file"), b"content").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let active = owner(&filesystem);
    let file = open(&filesystem, &active, &[b"file"], "download")
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    active.hooks.lock().unwrap().after_read = Some(Box::new(move || {
        entered.send(()).unwrap();
        blocked.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let params = || {
        decode_params(
            Operation::FsRead,
            json!({"handle":file.handle,"offset":"0","length":1}),
        )
        .unwrap()
    };
    let mut observations = vec![filesystem.enqueue(Arc::clone(&active), params()).unwrap()];
    tokio::time::timeout(Duration::from_secs(5), started)
        .await
        .unwrap()
        .unwrap();
    for _ in 0..3 {
        observations.push(filesystem.enqueue(Arc::clone(&active), params()).unwrap());
    }
    assert!(matches!(
        filesystem.enqueue(Arc::clone(&active), params()),
        Err(Error::Busy)
    ));
    drop(observations);
    assert_eq!(active.reads.available_permits(), 0);
    release.send(()).unwrap();
    let observer = owner(&filesystem);
    maintenance_barrier(&filesystem, &observer).await;
    assert_eq!(active.reads.available_permits(), 4);
    assert!(
        active
            .state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .readers
            .handles
            .is_empty()
    );
}

#[tokio::test]
async fn peer_retirement_releases_unclosed_readers_without_more_file_io() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("file"), b"content").unwrap();
    let filesystem = Filesystem::start(root.path().into()).unwrap();
    let active = owner(&filesystem);
    let service = Arc::new(GuestFiles {
        filesystem: filesystem.clone(),
        owner: Some(Arc::clone(&active)),
    });
    let mut peer = PeerFixture::new(service).await;
    assert!(
        wire(
            &mut peer,
            2,
            "open",
            json!({"path":[token(b"file")],"mode":"download"})
        )
        .await
        .get("result")
        .is_some()
    );
    peer.close().await;
    let observer = owner(&filesystem);
    maintenance_barrier(&filesystem, &observer).await;
    assert!(active.state.lock().unwrap().is_none());
}
