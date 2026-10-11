use std::os::unix::fs::{MetadataExt, PermissionsExt};

use tokio::net::{UnixListener, UnixStream};

use super::*;
use crate::runner_wss_socket::RunnerWssSocket;

fn fixture() -> (tempfile::TempDir, HomePaths) {
    let root = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(root.path().to_owned());
    std::fs::create_dir(home.wss_dir()).unwrap();
    std::fs::set_permissions(home.wss_dir(), std::fs::Permissions::from_mode(0o710)).unwrap();
    (root, home)
}

fn dead_owner(home: &HomePaths) -> (Uuid, std::path::PathBuf) {
    let directory = home.wss_dir();
    let (parent, _) = namespace::open(&directory).unwrap();
    let guard = NamespaceLock::acquire(&parent).unwrap();
    let id = Uuid::new_v4();
    let mut owner = Owner::acquire(&guard, &directory, id).unwrap();
    drop(guard);
    let name = format!(".wss-{}", Uuid::new_v4().simple());
    let anchor = directory.join(&name);
    let listener = UnixListener::bind(&anchor).unwrap();
    std::fs::set_permissions(&anchor, std::fs::Permissions::from_mode(0o660)).unwrap();
    owner
        .record(&std::fs::symlink_metadata(&anchor).unwrap(), &name)
        .unwrap();
    std::fs::hard_link(&anchor, directory.join(format!("{id}.sock"))).unwrap();
    drop(listener);
    drop(owner);
    (id, anchor)
}

#[tokio::test]
async fn reclamation_is_capped_and_preserves_live_and_starting_ids() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (_root, home) = fixture();
    let directory = home.wss_dir();
    let live_id = Uuid::new_v4();
    let live = RunnerWssSocket::bind(&directory, live_id).unwrap();
    let mut client = UnixStream::connect(directory.join(format!("{live_id}.sock")))
        .await
        .unwrap();
    let mut accepted = live.accept().await.unwrap();
    let (parent, _) = namespace::open(&directory).unwrap();
    let guard = NamespaceLock::acquire(&parent).unwrap();
    let starting_id = Uuid::new_v4();
    let starting = Owner::acquire(&guard, &directory, starting_id).unwrap();
    drop(guard);
    let starting_path = directory.join(format!("{starting_id}.lock"));
    let starting_inode = starting_path.metadata().unwrap().ino();
    for _ in 0..WSS_GC_MAX_IDS + 1 {
        dead_owner(&home);
    }
    assert_eq!(gc_wss_sockets(&home, true).unwrap(), WSS_GC_MAX_IDS);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), WSS_GC_MAX_IDS);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), 1);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), 0);
    assert_eq!(starting_path.metadata().unwrap().ino(), starting_inode);
    assert!(RunnerWssSocket::bind(&directory, starting_id).is_err());
    assert!(RunnerWssSocket::bind(&directory, live_id).is_err());
    client.write_all(b"alive").await.unwrap();
    let mut bytes = [0; 5];
    accepted.read_exact(&mut bytes).await.unwrap();
    assert_eq!(&bytes, b"alive");
    starting.retire_metadata().unwrap();
    drop(starting);
    drop(live);
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
}

#[tokio::test]
async fn unknown_socket_and_replaced_journal_are_preserved() {
    let (_root, home) = fixture();
    let directory = home.wss_dir();
    let (id, anchor) = dead_owner(&home);
    let final_path = directory.join(format!("{id}.sock"));
    std::fs::remove_file(&final_path).unwrap();
    let foreign = UnixListener::bind(&final_path).unwrap();
    std::fs::set_permissions(&final_path, std::fs::Permissions::from_mode(0o660)).unwrap();
    let before = final_path.metadata().unwrap().ino();
    drop(foreign);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), 0);
    assert_eq!(final_path.metadata().unwrap().ino(), before);
    assert!(anchor.exists());
    assert!(directory.join(format!("{id}.owner")).exists());

    let second_id = Uuid::new_v4();
    let socket = RunnerWssSocket::bind(&directory, second_id).unwrap();
    let journal = directory.join(format!("{second_id}.owner"));
    std::fs::remove_file(&journal).unwrap();
    std::fs::write(&journal, b"foreign metadata").unwrap();
    std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o600)).unwrap();
    let inode = journal.metadata().unwrap().ino();
    drop(socket);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), 0);
    assert_eq!(journal.metadata().unwrap().ino(), inode);
    assert_eq!(std::fs::read(journal).unwrap(), b"foreign metadata");
    assert!(directory.join(format!("{second_id}.lock")).exists());

    let third_id = Uuid::new_v4();
    let socket = RunnerWssSocket::bind(&directory, third_id).unwrap();
    let journal = directory.join(format!("{third_id}.owner"));
    let inode = journal.metadata().unwrap().ino();
    std::fs::write(&journal, b"in-place foreign metadata").unwrap();
    drop(socket);
    assert_eq!(gc_wss_sockets(&home, false).unwrap(), 0);
    assert_eq!(journal.metadata().unwrap().ino(), inode);
    assert_eq!(
        std::fs::read(journal).unwrap(),
        b"in-place foreign metadata"
    );
}

#[test]
fn concurrent_start_cannot_open_a_retiring_lock_inode() {
    let (_root, home) = fixture();
    let directory = home.wss_dir();
    let (parent, _) = namespace::open(&directory).unwrap();
    let guard = NamespaceLock::acquire(&parent).unwrap();
    let id = Uuid::new_v4();
    let retiring = Owner::acquire(&guard, &directory, id).unwrap();
    let path = directory.join(format!("{id}.lock"));
    let old_inode = path.metadata().unwrap().ino();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = std::sync::mpsc::channel();
    let next_directory = directory.clone();
    let thread = std::thread::spawn(move || {
        let (parent, _) = namespace::open(&next_directory).unwrap();
        entered_tx.send(()).unwrap();
        let guard = NamespaceLock::acquire(&parent).unwrap();
        let owner = Owner::acquire(&guard, &next_directory, id).unwrap();
        finished_tx.send(owner).unwrap();
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    retiring.retire_locked(&guard).unwrap();
    assert!(!path.exists());
    drop(guard);
    let next = finished_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    thread.join().unwrap();
    assert_ne!(path.metadata().unwrap().ino(), old_inode);
    let guard = NamespaceLock::acquire(&parent).unwrap();
    assert!(Owner::acquire(&guard, &directory, id).is_err());
    drop(guard);
    next.retire_metadata().unwrap();
}
