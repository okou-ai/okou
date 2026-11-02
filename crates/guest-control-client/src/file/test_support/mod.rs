use std::io;

use crate::{FrameWriteObserver, GuestControlClient};

pub(crate) const TEST_WRITE_FILE_CHUNK_LIMIT: usize = 1024;
pub(crate) const COPY_FILE_STREAM_CHUNK_LIMIT: u32 = super::copy::COPY_FILE_STREAM_CHUNK_LIMIT;
pub(crate) const COPY_FILE_STREAM_MAX_BYTES: u64 = super::copy::COPY_FILE_STREAM_MAX_BYTES;
pub(crate) const WRITE_FILE_CHUNK_LIMIT: usize = super::write::WRITE_FILE_CHUNK_LIMIT;
pub(crate) const WRITE_FILES_BATCH_CONTENT_LIMIT: usize =
    super::write::WRITE_FILES_BATCH_CONTENT_LIMIT;
pub(crate) const WRITE_FILES_BATCH_FILE_LIMIT: usize = super::write::WRITE_FILES_BATCH_FILE_LIMIT;

pub(crate) async fn write_file_with_small_chunks(
    host: &GuestControlClient,
    path: &str,
    content: &[u8],
    sudo: bool,
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    host.write_file_with_write_observer_and_chunk_limit(
        path,
        content,
        sudo,
        write_observer,
        TEST_WRITE_FILE_CHUNK_LIMIT,
    )
    .await
}

pub(crate) async fn write_private_file_with_small_chunks(
    host: &GuestControlClient,
    path: &str,
    content: &[u8],
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    host.write_private_file_with_write_observer_and_chunk_limit(
        path,
        content,
        write_observer,
        TEST_WRITE_FILE_CHUNK_LIMIT,
    )
    .await
}

pub(crate) async fn write_private_files_with_small_limits(
    host: &GuestControlClient,
    files: &[crate::WriteFileEntry<'_>],
    write_observer: FrameWriteObserver,
) -> io::Result<()> {
    host.write_private_files_with_write_observer_and_limits(
        files,
        write_observer,
        TEST_WRITE_FILE_CHUNK_LIMIT,
        TEST_WRITE_FILE_CHUNK_LIMIT,
    )
    .await
}
