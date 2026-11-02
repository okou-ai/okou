use std::future::Future;
use std::io::Write as _;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use tempfile::NamedTempFile;

use super::*;
use crate::{BLOCK_SIZE, cow::bitmap_path_for};

const TEST_TIMEOUT: Duration = Duration::from_secs(1);

fn create_test_cow_io() -> (NamedTempFile, NamedTempFile, CowIo) {
    let mut base = NamedTempFile::new().unwrap();
    base.write_all(&vec![0x11; BLOCK_SIZE]).unwrap();
    base.flush().unwrap();
    let cow_file = NamedTempFile::new().unwrap();
    let cow = CowLayer::new(
        base.path(),
        cow_file.path(),
        BLOCK_SIZE as u64,
        BLOCK_SIZE,
        BLOCK_SIZE * 4,
    )
    .unwrap();
    (base, cow_file, CowIo::new(cow))
}

fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
    let waker = Waker::noop();
    let mut context = Context::from_waker(waker);
    future.poll(&mut context)
}

#[tokio::test]
async fn save_bitmap_flushes_buffered_writes() {
    let mut base = NamedTempFile::new().unwrap();
    base.write_all(&vec![0x11; BLOCK_SIZE]).unwrap();
    base.flush().unwrap();
    let cow_file = NamedTempFile::new().unwrap();
    let cow = CowLayer::new(
        base.path(),
        cow_file.path(),
        BLOCK_SIZE as u64,
        BLOCK_SIZE,
        BLOCK_SIZE * 4,
    )
    .unwrap();
    let cow = CowIo::new(cow);

    let write_data = vec![0x22; BLOCK_SIZE];
    cow.write(0, write_data.clone()).await.unwrap();
    assert_eq!(
        cow.status().await.unwrap(),
        CowIoStatus {
            dirty_blocks: 0,
            buffered_blocks: 1,
            buffer_bytes: BLOCK_SIZE,
        }
    );

    cow.save_bitmap(bitmap_path_for(cow_file.path()))
        .await
        .unwrap();

    assert_eq!(
        cow.status().await.unwrap(),
        CowIoStatus {
            dirty_blocks: 1,
            buffered_blocks: 0,
            buffer_bytes: 0,
        }
    );
    let restored = CowLayer::new(
        base.path(),
        cow_file.path(),
        BLOCK_SIZE as u64,
        BLOCK_SIZE,
        BLOCK_SIZE * 4,
    )
    .unwrap();
    let mut restored_data = vec![0; BLOCK_SIZE];
    restored.read(0, &mut restored_data).unwrap();
    assert_eq!(restored_data, write_data);
}

#[tokio::test]
async fn relocated_path_controls_lazy_cow_file_open() {
    let mut base = NamedTempFile::new().unwrap();
    base.write_all(&vec![0x11; BLOCK_SIZE]).unwrap();
    base.flush().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let source_dir = tmp.path().join("slot");
    let target_dir = tmp.path().join("sandbox");
    std::fs::create_dir(&source_dir).unwrap();
    std::fs::create_dir(&target_dir).unwrap();
    let source_cow = source_dir.join("cow.img");
    let target_cow = target_dir.join("cow.img");
    std::fs::File::create(&source_cow)
        .unwrap()
        .set_len(BLOCK_SIZE as u64)
        .unwrap();
    let cow = CowLayer::new(
        base.path(),
        &source_cow,
        BLOCK_SIZE as u64,
        BLOCK_SIZE,
        BLOCK_SIZE * 4,
    )
    .unwrap();
    let cow = CowIo::new(cow);

    std::fs::rename(&source_cow, &target_cow).unwrap();
    cow.relocate_cow_file_after_rename(target_cow.clone())
        .unwrap();
    let write_data = vec![0x22; BLOCK_SIZE];
    cow.write(0, write_data.clone()).await.unwrap();
    cow.sync().await.unwrap();

    assert!(!source_cow.exists());
    assert_eq!(std::fs::read(target_cow).unwrap(), write_data);
}

#[tokio::test]
async fn cancelled_slot_waiter_does_not_submit_write() {
    let (_base, _cow_file, cow) = create_test_cow_io();
    let occupied_slot = cow
        .inner
        .operation_slot
        .clone()
        .try_acquire_owned()
        .unwrap();
    let mut cancelled_write = Box::pin(cow.write(0, vec![0x22; BLOCK_SIZE]));

    assert!(poll_once(cancelled_write.as_mut()).is_pending());
    drop(cancelled_write);
    drop(occupied_slot);

    let status = tokio::time::timeout(TEST_TIMEOUT, cow.status())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        status,
        CowIoStatus {
            dirty_blocks: 0,
            buffered_blocks: 0,
            buffer_bytes: 0,
        }
    );
    let data = tokio::time::timeout(TEST_TIMEOUT, cow.read(0, vec![0; BLOCK_SIZE]))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(data, vec![0x11; BLOCK_SIZE]);
}

#[tokio::test]
async fn submitted_write_retains_slot_after_awaiter_cancellation() {
    let (_base, _cow_file, cow) = create_test_cow_io();
    let cow_gate = cow.inner.cow.try_lock().unwrap();
    let write_data = vec![0x22; BLOCK_SIZE];
    let mut cancelled_write = Box::pin(cow.write(0, write_data.clone()));

    assert!(poll_once(cancelled_write.as_mut()).is_pending());
    drop(cancelled_write);
    assert_eq!(cow.inner.operation_slot.available_permits(), 0);

    let mut follow_up_read = Box::pin(cow.read(0, vec![0; BLOCK_SIZE]));
    assert!(poll_once(follow_up_read.as_mut()).is_pending());
    drop(cow_gate);

    let data = tokio::time::timeout(TEST_TIMEOUT, follow_up_read)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(data, write_data);
    assert_eq!(cow.inner.operation_slot.available_permits(), 1);
}
