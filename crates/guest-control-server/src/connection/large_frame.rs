use std::fs::File;
use std::io::{self, Read, Seek, Write};
use std::ops::RangeInclusive;
use std::os::fd::AsFd;

use bytes::Bytes;
use guest_contracts::sealed_input::SealedInput;
use guest_contracts::storage_files::MAX_INPUT_BYTES;
use guest_control_proto::{Decoder, IncompleteFrame};

use crate::error::to_io_error;
use crate::log::log;
use crate::sealed_input;

// Stream ordinary batches from 1 MiB into the sealed helper input while the
// frame is incomplete. This avoids full decoder buffering and the helper pipe
// copy for medium archive staging requests.
pub(super) const STREAMED_BATCH_MIN_BYTES: usize = 1024 * 1024;

// Keep small inputs in the decoder's reusable buffer. The sealed file holds
// both the RPC context and the helper input and must fit the helper's map limit.
pub(super) const STREAMED_STORAGE_PAYLOAD_BYTES: RangeInclusive<usize> =
    4 * 1024 * 1024..=MAX_INPUT_BYTES;

pub(super) fn receive_write(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
) -> io::Result<Option<(File, usize)>> {
    let mut input = sealed_input::create(c"guest-write-files")?;
    Ok(receive_into(reader, scratch, frame, &mut input)?.map(|retained| (input, retained)))
}

pub(super) enum ReceivedStorage {
    Buffered(Bytes),
    Sealed { file: File, mapping: SealedInput },
}

pub(super) fn receive_storage(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
) -> io::Result<Option<(ReceivedStorage, usize)>> {
    let mut input = match sealed_input::create(c"guest-storage-receive") {
        Ok(file) => StorageBuffer::File(file),
        Err(error) => {
            log_storage_buffer_fallback(&error);
            StorageBuffer::Heap(Vec::with_capacity(frame.payload_len))
        }
    };
    let Some(retained) = receive_into(reader, scratch, frame, &mut input)? else {
        return Ok(None);
    };
    Ok(Some((input.finish()?, retained)))
}

enum StorageBuffer {
    File(File),
    Heap(Vec<u8>),
}

impl StorageBuffer {
    fn finish(self) -> io::Result<ReceivedStorage> {
        match self {
            Self::Heap(payload) => Ok(ReceivedStorage::Buffered(payload.into())),
            Self::File(mut file) => {
                let mapping = sealed_input::seal(&file)
                    .and_then(|()| SealedInput::map(file.as_fd(), MAX_INPUT_BYTES));
                match mapping {
                    Ok(mapping) => Ok(ReceivedStorage::Sealed { file, mapping }),
                    Err(error) => {
                        let payload = recover_storage_prefix(&mut file, &error)?;
                        Ok(ReceivedStorage::Buffered(payload.into()))
                    }
                }
            }
        }
    }
}

impl Write for StorageBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        match self {
            Self::Heap(payload) => payload.write(bytes),
            Self::File(file) => match file.write(bytes) {
                Err(error) if error.kind() != io::ErrorKind::Interrupted => {
                    let mut payload = recover_storage_prefix(file, &error)?;
                    payload.extend_from_slice(bytes);
                    *self = Self::Heap(payload);
                    Ok(bytes.len())
                }
                result => result,
            },
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Heap(payload) => payload.flush(),
            Self::File(file) => file.flush(),
        }
    }
}

fn log_storage_buffer_fallback(error: &io::Error) {
    log(
        "WARN",
        &format!("Could not stream Storage input to a sealed file: {error}"),
    );
}

fn recover_storage_prefix(file: &mut File, error: &io::Error) -> io::Result<Vec<u8>> {
    log_storage_buffer_fallback(error);
    // The receiver owns the file and has only made sequential writes. Its
    // cursor marks the prefix already consumed, including any short writes.
    let length = file.stream_position()?;
    file.rewind()?;
    let mut payload = Vec::new();
    file.take(length).read_to_end(&mut payload)?;
    if payload.len() as u64 != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "could not recover the consumed Storage frame prefix",
        ));
    }
    Ok(payload)
}

/// Finish receiving the bounded payload. Preflight coalesced following bytes
/// before dispatch and retain them in scratch for the ordinary decoder.
/// EOF leaves the caller with an incomplete input to discard.
pub(super) fn receive_into(
    reader: &mut impl Read,
    scratch: &mut [u8],
    frame: &IncompleteFrame,
    mut input: impl Write,
) -> io::Result<Option<usize>> {
    let prefix = frame.received_payload();
    input.write_all(prefix)?;
    let mut remaining = frame.payload_len - prefix.len();
    loop {
        let received = match reader.read(scratch) {
            Ok(0) => return Ok(None),
            Ok(received) => received,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        input.write_all(scratch.split_at(remaining.min(received)).0)?;
        if remaining <= received {
            scratch.copy_within(remaining..received, 0);
            let retained = received - remaining;
            Decoder::validate_buffered_framing(scratch.split_at(retained).0)
                .map_err(to_io_error)?;
            return Ok(Some(retained));
        }
        remaining -= received;
    }
}

#[cfg(test)]
mod tests;
