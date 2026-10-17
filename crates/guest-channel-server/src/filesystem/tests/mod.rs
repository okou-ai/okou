use super::*;
mod reading;
use api_contracts::generated::types::sandbox_channel::fs;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use guest_contracts::sandbox_channel::{decode_params, decode_result};
use serde_json::json;
use std::{
    collections::BTreeSet,
    ffi::OsString,
    os::unix::{ffi::OsStringExt, fs::symlink},
    path::Path,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

fn owner(filesystem: &Filesystem) -> Arc<Owner> {
    Arc::new(Owner {
        cancelled: CancellationToken::new(),
        peer: Mutex::new(None),
        reads: Arc::new(Semaphore::new(limits::fs::MAX_IN_FLIGHT_READS as usize)),
        state: Mutex::new(None),
        _permit: Arc::clone(&filesystem.owners).try_acquire_owned().unwrap(),
        hooks: Mutex::new(Hooks::default()),
    })
}

async fn request(
    filesystem: &Filesystem,
    owner: &Arc<Owner>,
    operation: Operation,
    value: Value,
) -> Result<Value, Error> {
    let params = decode_params(operation, value)?;
    let value = filesystem
        .enqueue(Arc::clone(owner), params)?
        .await
        .unwrap()?;
    decode_result(operation, value.clone())?;
    Ok(value)
}

async fn list(
    filesystem: &Filesystem,
    owner: &Arc<Owner>,
    value: Value,
) -> Result<fs::ListResult, Error> {
    serde_json::from_value(request(filesystem, owner, Operation::FsList, value).await?)
        .map_err(|_| Error::Unavailable)
}

async fn maintenance_barrier(filesystem: &Filesystem, owner: &Arc<Owner>) {
    // The worker may already be waiting for a job after sweeping a live owner.
    // Wake it first, then await another job after the next maintenance pass.
    list(filesystem, owner, json!({"path":[]})).await.unwrap();
    list(filesystem, owner, json!({"path":[]})).await.unwrap();
}

fn tree(path: &Path, count: usize) {
    for index in 0..count {
        std::fs::write(path.join(format!("file-{index:04}")), b"private contents").unwrap();
    }
}

fn token(name: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(name)
}

#[tokio::test]
async fn guest_root_home_and_nested_locations_use_one_raw_namespace() {
    let guest = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(guest.path().join("home/user/workspace")).unwrap();
    std::fs::write(guest.path().join("home/user/workspace/leaf"), b"private").unwrap();
    let filesystem = Filesystem::start(guest.path().into()).unwrap();
    let owner = owner(&filesystem);
    for (parts, expected) in [
        (vec![], "home"),
        (vec!["home"], "user"),
        (vec!["home", "user"], "workspace"),
        (vec!["home", "user", "workspace"], "leaf"),
    ] {
        let path: Vec<_> = parts.iter().map(|name| token(name.as_bytes())).collect();
        let page = list(&filesystem, &owner, json!({"path":path}))
            .await
            .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].name_token, token(expected.as_bytes()));
        assert!(page.next_cursor.is_none());
    }
}

#[tokio::test]
async fn canonical_home_transition_still_rejects_symlink_replacement() {
    let guest = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(guest.path().join("home")).unwrap();
    symlink(outside.path(), guest.path().join("home/user")).unwrap();
    let filesystem = Filesystem::start(guest.path().into()).unwrap();
    let owner = owner(&filesystem);
    assert_eq!(
        list(
            &filesystem,
            &owner,
            json!({"path":[token(b"home"),token(b"user")]})
        )
        .await
        .unwrap_err(),
        Error::LinkNotExpandable,
    );
}

#[tokio::test]
async fn raw_names_kinds_and_safe_labels_never_follow_links_or_open_contents() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("nested")).unwrap();
    std::fs::write(home.path().join(".hidden"), b"secret").unwrap();
    let raw = b"raw-\xff\n\x7f";
    std::fs::write(
        home.path().join(OsString::from_vec(raw.to_vec())),
        b"secret",
    )
    .unwrap();
    symlink("/", home.path().join("outside")).unwrap();
    symlink("cycle", home.path().join("cycle")).unwrap();
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let owner = owner(&filesystem);
    let page = list(&filesystem, &owner, json!({"path":[]})).await.unwrap();
    assert!(page.next_cursor.is_none());
    assert_eq!(page.entries.len(), 5);
    assert!(
        page.entries
            .iter()
            .any(|entry| entry.name_token == token(b".hidden"))
    );
    let unsafe_name = page
        .entries
        .iter()
        .find(|entry| entry.name_token == token(raw))
        .unwrap();
    assert_eq!(unsafe_name.display_name, "raw-\\xff\\n\\u{7f}");
    let link = page
        .entries
        .iter()
        .find(|entry| entry.name_token == token(b"outside"))
        .unwrap();
    assert_eq!(link.kind, fs::ListResultEntrieKind::Symlink);
    for name in [b"outside".as_slice(), b"cycle"] {
        assert_eq!(
            list(&filesystem, &owner, json!({"path":[token(name)]}))
                .await
                .unwrap_err(),
            Error::LinkNotExpandable
        );
    }
    assert_eq!(
        list(&filesystem, &owner, json!({"path":[token(b".hidden")]}))
            .await
            .unwrap_err(),
        Error::NotDirectory
    );
    let nested = list(&filesystem, &owner, json!({"path":[token(b"nested")]}))
        .await
        .unwrap();
    assert!(nested.entries.is_empty() && nested.next_cursor.is_none());
    for invalid in ["", "Li4", "Lw", "AA", "Zg=", "Zh"] {
        assert!(
            list(&filesystem, &owner, json!({"path":[invalid]}))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn independent_byte_limited_cursors_preserve_every_buffered_raw_entry() {
    let home = tempfile::tempdir().unwrap();
    for index in 0..160 {
        let mut bytes = vec![0xff; 250];
        bytes.extend_from_slice(format!("{index:05}").as_bytes());
        std::fs::write(home.path().join(OsString::from_vec(bytes)), b"").unwrap();
    }
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let owner = owner(&filesystem);
    let first = list(&filesystem, &owner, json!({"path":[]})).await.unwrap();
    let second = list(&filesystem, &owner, json!({"path":[]})).await.unwrap();
    assert_ne!(first.listing_id, second.listing_id);
    assert!(first.entries.len() < 128 && first.next_cursor.is_some());
    assert_eq!(first.entries, second.entries);
    for mut page in [first, second] {
        let listing = page.listing_id.clone();
        let mut names = BTreeSet::new();
        let mut pages = 0;
        loop {
            let encoded = serde_json::to_vec(&json!({"schemaVersion":1,"type":"response","id":"00000000-0000-4000-8000-000000000001","requestId":"00000000-0000-4000-8000-000000000002","result":page})).unwrap();
            assert!(encoded.len() <= limits::fs::MAX_RESPONSE_BYTES as usize);
            assert_eq!(page.listing_id, listing);
            for entry in page.entries {
                assert!(names.insert(entry.name_token));
            }
            pages += 1;
            let Some(cursor) = page.next_cursor else {
                break;
            };
            assert!(pages < 20);
            page = list(&filesystem, &owner, json!({"cursor":cursor}))
                .await
                .unwrap();
        }
        assert_eq!(names.len(), 160);
    }
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .cursors
            .is_empty()
    );
}

#[tokio::test]
async fn cursor_cap_foreign_close_expiry_and_connection_disposal_are_owned() {
    let home = tempfile::tempdir().unwrap();
    tree(home.path(), 300);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let first = owner(&filesystem);
    let foreign = owner(&filesystem);
    let mut cursors = Vec::new();
    for _ in 0..8 {
        cursors.push(
            list(&filesystem, &first, json!({"path":[]}))
                .await
                .unwrap()
                .next_cursor
                .unwrap(),
        );
    }
    assert_eq!(
        list(&filesystem, &first, json!({"path":[]}))
            .await
            .unwrap_err(),
        Error::Busy
    );
    assert_eq!(
        list(&filesystem, &foreign, json!({"cursor":cursors[0]}))
            .await
            .unwrap_err(),
        Error::CursorExpired
    );
    request(
        &filesystem,
        &first,
        Operation::FsListClose,
        json!({"cursor":cursors[0]}),
    )
    .await
    .unwrap();
    assert_eq!(
        list(&filesystem, &first, json!({"cursor":cursors[0]}))
            .await
            .unwrap_err(),
        Error::CursorExpired
    );
    first
        .state
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .cursors
        .get_mut(&cursors[1])
        .unwrap()
        .idle_until = Instant::now();
    assert_eq!(
        list(&filesystem, &first, json!({"cursor":cursors[1]}))
            .await
            .unwrap_err(),
        Error::CursorExpired
    );
    assert_eq!(
        first.state.lock().unwrap().as_ref().unwrap().cursors.len(),
        6
    );
    let weak = Arc::downgrade(&first);
    first.cancelled.cancel();
    drop(first);
    // Reuse the surviving owner so the barrier cannot hold another owner permit.
    maintenance_barrier(&filesystem, &foreign).await;
    assert!(weak.upgrade().is_none());
    assert_eq!(filesystem.owners.available_permits(), RETAINED_OWNERS - 1);
}

#[tokio::test]
async fn mutation_and_ancestor_replacement_discard_the_original_listing() {
    let home = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(home.path().join("parent/child")).unwrap();
    tree(&home.path().join("parent/child"), 300);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let owner = owner(&filesystem);
    let path = json!({"path":[token(b"parent"),token(b"child")]});
    let cursor = list(&filesystem, &owner, path.clone())
        .await
        .unwrap()
        .next_cursor
        .unwrap();
    std::fs::write(home.path().join("parent/child/new"), b"").unwrap();
    assert_eq!(
        list(&filesystem, &owner, json!({"cursor":cursor}))
            .await
            .unwrap_err(),
        Error::DirectoryChanged
    );
    let moved = outside.path().join("moved");
    let original = home.path().join("parent");
    owner.hooks.lock().unwrap().after_read = Some(Box::new(move || {
        std::fs::rename(&original, &moved).unwrap();
        std::fs::create_dir_all(original.join("child")).unwrap();
    }));
    assert_eq!(
        list(&filesystem, &owner, path).await.unwrap_err(),
        Error::DirectoryChanged
    );
    assert!(
        owner
            .state
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .cursors
            .is_empty()
    );
}

#[tokio::test]
async fn deep_path_step_budget_keeps_a_real_continuation_and_honest_eof() {
    let home = tempfile::tempdir().unwrap();
    let mut directory = home.path().to_path_buf();
    let mut tokens = Vec::new();
    for _ in 0..64 {
        directory.push("d");
        std::fs::create_dir(&directory).unwrap();
        tokens.push(token(b"d"));
    }
    tree(&directory, 180);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let owner = owner(&filesystem);
    let mut page = list(&filesystem, &owner, json!({"path":tokens}))
        .await
        .unwrap();
    assert!(page.entries.len() < 128 && page.next_cursor.is_some());
    let mut names = BTreeSet::new();
    let mut pages = 0;
    loop {
        for entry in page.entries {
            assert!(names.insert(entry.name_token));
        }
        pages += 1;
        let Some(cursor) = page.next_cursor else {
            break;
        };
        assert!(pages < 10);
        page = list(&filesystem, &owner, json!({"cursor":cursor}))
            .await
            .unwrap();
    }
    assert_eq!(names.len(), 180);
}

#[tokio::test]
async fn a_step_limited_empty_page_preserves_unread_directory_entries() {
    let home = tempfile::tempdir().unwrap();
    tree(home.path(), 10);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let owner = owner(&filesystem);
    list(&filesystem, &owner, json!({"path":[]})).await.unwrap();
    let (result, _receiver) = oneshot::channel();
    let job = Job {
        owner: Arc::clone(&owner),
        root: home.path().into(),
        params: decode_params(Operation::FsList, json!({"path":[]})).unwrap(),
        result,
        _bytes: Arc::clone(&filesystem.bytes).try_acquire_owned().unwrap(),
        _read: None,
    };
    let mut state = owner.state.lock().unwrap().take().unwrap();
    let mut scope = Scope {
        job: &job,
        deadline: Instant::now() + Duration::from_secs(2),
        steps: 498,
    };
    let page: fs::ListResult =
        serde_json::from_value(state.execute(&job.params, &mut scope).unwrap()).unwrap();
    assert!(scope.steps <= limits::fs::MAX_ENUMERATION_STEPS as usize);
    assert!(page.entries.is_empty());
    let cursor = page.next_cursor.unwrap();
    *owner.state.lock().unwrap() = Some(state);
    let continued = list(&filesystem, &owner, json!({"cursor":cursor}))
        .await
        .unwrap();
    assert_eq!(continued.entries.len(), 10);
    assert!(continued.next_cursor.is_none());
}

struct PeerFixture {
    stream: DuplexStream,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
}
impl PeerFixture {
    async fn new(service: Arc<dyn Service>) -> Self {
        let (mut stream, guest) = tokio::io::duplex(256 * 1024);
        let task = tokio::spawn(crate::serve(guest, service));
        assert_eq!(
            stream.read_u8().await.unwrap(),
            guest_contracts::private_duplex::ACTIVATED
        );
        let mut fixture = Self { stream, task };
        fixture.send(json!({"schemaVersion":1,"type":"hello","id":id(1),"categories":{"diagnostics":1,"fs":3}})).await;
        assert_eq!(fixture.receive().await["result"]["categories"]["fs"], 3);
        assert_eq!(fixture.receive().await["event"], "notice");
        fixture
    }
    async fn send(&mut self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        self.stream.write_u32(bytes.len() as u32).await.unwrap();
        self.stream.write_all(&bytes).await.unwrap();
    }
    async fn receive(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(5), async {
            let length = self.stream.read_u32().await.unwrap();
            let mut bytes = vec![0; length as usize];
            self.stream.read_exact(&mut bytes).await.unwrap();
            serde_json::from_slice(&bytes).unwrap()
        })
        .await
        .unwrap()
    }
    async fn close(mut self) {
        self.stream.shutdown().await.unwrap();
        self.task.await.unwrap().unwrap();
    }
}
fn id(n: u64) -> String {
    format!("00000000-0000-4000-8000-{n:012x}")
}

#[tokio::test]
async fn old_fs_category_cannot_reinterpret_home_paths_as_guest_root() {
    let guest = tempfile::tempdir().unwrap();
    std::fs::create_dir(guest.path().join("home")).unwrap();
    let filesystem = Filesystem::start(guest.path().into()).unwrap();
    let mut fixture = PeerFixture::new(filesystem.service()).await;
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(2),"category":"fs","categoryVersion":1,"operation":"list","params":{"path":[]}})).await;
    assert_eq!(
        fixture.receive().await["error"]["code"],
        "category_version_mismatch"
    );
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(3),"category":"fs","categoryVersion":3,"operation":"list","params":{"path":[]}})).await;
    let reply = fixture.receive().await;
    assert_eq!(reply["result"]["entries"][0]["nameToken"], token(b"home"));
    fixture.close().await;
}

#[tokio::test]
async fn cancelled_peer_releases_its_observation_before_physical_filesystem_work_unwinds() {
    let home = tempfile::tempdir().unwrap();
    tree(home.path(), 300);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let active = owner(&filesystem);
    let (entered, waiting) = oneshot::channel();
    let (release, gate) = mpsc::sync_channel(1);
    active.hooks.lock().unwrap().after_read = Some(Box::new(move || {
        entered.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let weak = Arc::downgrade(&active);
    let mut fixture = PeerFixture::new(Arc::new(GuestFiles {
        filesystem: filesystem.clone(),
        owner: Some(Arc::clone(&active)),
    }))
    .await;
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(2),"category":"fs","categoryVersion":3,"operation":"list","params":{"path":[]}})).await;
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), fixture.close())
        .await
        .unwrap();
    assert!(active.closed());
    drop(active);
    assert!(
        weak.upgrade().is_some(),
        "Physical work must keep the retired owner alive"
    );
    assert_eq!(filesystem.owners.available_permits(), RETAINED_OWNERS - 1);
    let replacement = owner(&filesystem);
    let resumed = filesystem
        .enqueue(
            Arc::clone(&replacement),
            decode_params(Operation::FsList, json!({"path":[]})).unwrap(),
        )
        .unwrap();
    release.send(()).unwrap();
    let page = resumed.await.unwrap().unwrap();
    decode_result(Operation::FsList, page).unwrap();
    assert!(
        weak.upgrade().is_none(),
        "Abandoned work must release state after its physical boundary unwinds"
    );
    assert_eq!(filesystem.owners.available_permits(), RETAINED_OWNERS - 1);
}

#[tokio::test]
async fn peer_closing_during_maintenance_releases_filesystem_state() {
    let home = tempfile::tempdir().unwrap();
    tree(home.path(), 300);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let active = owner(&filesystem);
    let (entered, waiting) = oneshot::channel();
    let (release, gate) = mpsc::sync_channel(1);
    active.hooks.lock().unwrap().after_maintenance = Some(Box::new(move || {
        entered.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let mut fixture = PeerFixture::new(Arc::new(GuestFiles {
        filesystem: filesystem.clone(),
        owner: Some(Arc::clone(&active)),
    }))
    .await;
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(2),"category":"fs","categoryVersion":3,"operation":"list","params":{"path":[]}})).await;
    assert!(fixture.receive().await["result"]["nextCursor"].is_string());
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), fixture.close())
        .await
        .unwrap();
    assert!(active.closed());
    release.send(()).unwrap();
    let fresh = owner(&filesystem);
    maintenance_barrier(&filesystem, &fresh).await;
    assert!(active.state.lock().unwrap().is_none());
}

#[tokio::test]
async fn blocked_physical_worker_keeps_protocol_routing_live_and_admission_bounded() {
    let home = tempfile::tempdir().unwrap();
    tree(home.path(), 300);
    let filesystem = Filesystem::start(home.path().into()).unwrap();
    let first = owner(&filesystem);
    let (entered, waiting) = oneshot::channel();
    let (release, gate) = mpsc::sync_channel(1);
    first.hooks.lock().unwrap().before_job = Some(Box::new(move || {
        entered.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let service = Arc::new(GuestFiles {
        filesystem: filesystem.clone(),
        owner: Some(Arc::clone(&first)),
    });
    let mut fixture = PeerFixture::new(service).await;
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(2),"category":"fs","categoryVersion":3,"operation":"list","params":{"path":[]}})).await;
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    fixture.send(json!({"schemaVersion":1,"type":"request","id":id(3),"category":"diagnostics","categoryVersion":1,"operation":"echo","params":{"payload":""}})).await;
    assert_eq!(fixture.receive().await["requestId"], id(3));
    for (n, operation, params, code) in [
        (4, "list", json!({"path":[token(b"..")] }), "invalid_params"),
        (5, "unknown", json!({"path":[]}), "unknown_operation"),
    ] {
        fixture.send(json!({"schemaVersion":1,"type":"request","id":id(n),"category":"fs","categoryVersion":3,"operation":operation,"params":params})).await;
        assert_eq!(fixture.receive().await["error"]["code"], code);
    }
    let mut queued = Vec::new();
    for _ in 0..QUEUED_JOBS {
        let retired = owner(&filesystem);
        let params = decode_params(Operation::FsList, json!({"path":[]})).unwrap();
        queued.push((
            filesystem.enqueue(Arc::clone(&retired), params).unwrap(),
            retired,
        ));
    }
    let extra = owner(&filesystem);
    assert_eq!(
        filesystem
            .enqueue(
                Arc::clone(&extra),
                decode_params(Operation::FsList, json!({"path":[]})).unwrap()
            )
            .unwrap_err(),
        Error::Busy
    );
    assert_eq!(filesystem.owners.available_permits(), RETAINED_OWNERS - 10);
    let live: Vec<_> = (0..7).map(|_| owner(&filesystem)).collect();
    assert_eq!(filesystem.owners.available_permits(), 0);
    let mut pressured = PeerFixture::new(filesystem.service()).await;
    pressured.send(json!({"schemaVersion":1,"type":"request","id":id(6),"category":"diagnostics","categoryVersion":1,"operation":"echo","params":{"payload":""}})).await;
    assert_eq!(pressured.receive().await["result"], json!({"payload":""}));
    pressured.send(json!({"schemaVersion":1,"type":"request","id":id(7),"category":"fs","categoryVersion":3,"operation":"list","params":{"path":[]}})).await;
    assert_eq!(pressured.receive().await["error"]["code"], "busy");
    pressured.close().await;
    drop(live);
    for (_, retired) in &queued {
        retired.cancelled.cancel();
    }
    release.send(()).unwrap();
    assert!(fixture.receive().await["result"]["nextCursor"].is_string());
    for (receiver, _) in queued {
        assert!(receiver.await.is_err());
    }
    drop(extra);
    fixture.close().await;
    assert!(first.closed());
    let fresh = owner(&filesystem);
    maintenance_barrier(&filesystem, &fresh).await;
    assert!(first.state.lock().unwrap().is_none());
}
