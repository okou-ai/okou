use std::{
    cell::Cell,
    io::{self, Read, Write},
    path::Path,
    rc::Rc,
};

use super::{R2Error, io_other};

pub(super) const TEMPLATE_FILE: &str = "template.ext4";
const ZSTD_LEVEL: i32 = 3;
const TAR_BLOCK_BYTES: u64 = 512;
const TAR_TRAILER_BYTES: u64 = TAR_BLOCK_BYTES * 2;
pub(super) const MAX_TEMPLATE_METADATA_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ZSTD_STREAMING_OVERHEAD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ZSTD_WINDOW_LOG: u32 = 27;

#[derive(Clone, Copy, Debug)]
pub(super) struct TemplateArchiveLimits {
    max_decompressed_bytes: u64,
    max_compressed_bytes: u64,
}

impl TemplateArchiveLimits {
    pub(super) fn new(expected_template_bytes: u64) -> Result<Self, R2Error> {
        let max_decompressed_bytes = expected_template_bytes
            .checked_add(MAX_TEMPLATE_METADATA_BYTES)
            .and_then(|value| value.checked_add(TAR_BLOCK_BYTES - 1))
            .and_then(|value| value.checked_add(TAR_TRAILER_BYTES))
            .ok_or_else(|| R2Error::Io(io_other("template archive size limit overflow")))?;
        let compress_bound_input = usize::try_from(max_decompressed_bytes).map_err(|_| {
            R2Error::Io(io_other(
                "template archive decompressed limit does not fit usize",
            ))
        })?;
        let max_compressed_bytes =
            u64::try_from(zstd::zstd_safe::compress_bound(compress_bound_input))
                .map_err(|_| R2Error::Io(io_other("zstd compressed limit does not fit u64")))?
                .checked_add(MAX_ZSTD_STREAMING_OVERHEAD_BYTES)
                .ok_or_else(|| {
                    R2Error::Io(io_other("template archive compressed limit overflow"))
                })?;

        Ok(Self {
            max_decompressed_bytes,
            max_compressed_bytes,
        })
    }

    pub(super) fn max_compressed_bytes(self) -> u64 {
        self.max_compressed_bytes
    }
}

#[derive(Debug)]
pub(super) enum TemplateUnpackError {
    Invalid(R2Error),
    Local(R2Error),
}

impl TemplateUnpackError {
    fn invalid(error: io::Error) -> Self {
        Self::Invalid(R2Error::Io(error))
    }

    fn invalid_message(message: impl std::fmt::Display) -> Self {
        Self::invalid(io_other(message))
    }
}

pub(super) fn pack_template_to_writer<W: Write>(writer: W, template: &Path) -> Result<(), R2Error> {
    let mut encoder = zstd::stream::write::Encoder::new(writer, ZSTD_LEVEL)?;
    encoder.multithread(zstd_workers())?;
    let mut builder = tar::Builder::new(encoder);
    builder.append_path_with_name(template, TEMPLATE_FILE)?;
    // Explicit finalization order:
    //   1. tar trailer (two zero blocks)        — `into_inner` calls `finish` first
    //   2. zstd frame footer                     — `Encoder::finish`
    // Avoid `auto_finish()` which silently swallows errors during drop.
    let encoder = builder.into_inner()?;
    encoder.finish()?;
    Ok(())
}

/// Worker count for multi-threaded zstd encoding. Capped at 4 because:
/// - extra workers add memory (each gets its own input buffer)
/// - upload-side concurrency is also 4, so going wider gives diminishing returns
/// - tests run on possibly-small CI runners
fn zstd_workers() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4) as u32)
        .unwrap_or(2)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReadPhase {
    Metadata,
    Payload,
}

struct CompressedLimitReader<R> {
    inner: R,
    remaining: u64,
}

impl<R> CompressedLimitReader<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            remaining: limit,
        }
    }
}

impl<R: Read> Read for CompressedLimitReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            return reject_byte_after_limit(
                &mut self.inner,
                "template archive exceeds compressed byte limit",
            );
        }

        let allowed = usize::try_from(self.remaining)
            .unwrap_or(buf.len())
            .min(buf.len());
        let allowed_buf = buf
            .get_mut(..allowed)
            .ok_or_else(|| io_other("compressed reader buffer limit is invalid"))?;
        let read = self.inner.read(allowed_buf)?;
        self.remaining -= read as u64;
        Ok(read)
    }
}

struct DecompressedLimitReader<R> {
    inner: R,
    remaining_total: u64,
    remaining_metadata: u64,
    phase: Rc<Cell<ReadPhase>>,
}

impl<R> DecompressedLimitReader<R> {
    fn new(inner: R, limits: TemplateArchiveLimits, phase: Rc<Cell<ReadPhase>>) -> Self {
        Self {
            inner,
            remaining_total: limits.max_decompressed_bytes,
            remaining_metadata: MAX_TEMPLATE_METADATA_BYTES,
            phase,
        }
    }

    fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: Read> Read for DecompressedLimitReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }

        let remaining = if self.phase.get() == ReadPhase::Metadata {
            self.remaining_total.min(self.remaining_metadata)
        } else {
            self.remaining_total
        };
        if remaining == 0 {
            let message = if self.remaining_total == 0 {
                "template archive exceeds decompressed byte limit"
            } else {
                "template archive exceeds metadata byte limit"
            };
            return reject_byte_after_limit(&mut self.inner, message);
        }

        let allowed = usize::try_from(remaining)
            .unwrap_or(buf.len())
            .min(buf.len());
        let allowed_buf = buf
            .get_mut(..allowed)
            .ok_or_else(|| io_other("decompressed reader buffer limit is invalid"))?;
        let read = self.inner.read(allowed_buf)?;
        self.remaining_total -= read as u64;
        if self.phase.get() == ReadPhase::Metadata {
            self.remaining_metadata -= read as u64;
        }
        Ok(read)
    }
}

fn reject_byte_after_limit<R: Read>(reader: &mut R, message: &'static str) -> io::Result<usize> {
    let mut byte = [0u8; 1];
    if reader.read(&mut byte)? == 0 {
        Ok(0)
    } else {
        Err(io::Error::new(io::ErrorKind::InvalidData, message))
    }
}

struct PrefixReader<R> {
    prefix: io::Cursor<[u8; TAR_BLOCK_BYTES as usize]>,
    inner: R,
}

impl<R> PrefixReader<R> {
    fn new(prefix: [u8; TAR_BLOCK_BYTES as usize], inner: R) -> Self {
        Self {
            prefix: io::Cursor::new(prefix),
            inner,
        }
    }

    fn into_inner(self) -> R {
        self.inner
    }
}

impl<R: Read> Read for PrefixReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.prefix.read(buf)?;
        if read == 0 {
            self.inner.read(buf)
        } else {
            Ok(read)
        }
    }
}

fn unpack_template_from_reader<R: Read>(
    reader: R,
    staging: &Path,
    expected_template_bytes: u64,
    limits: TemplateArchiveLimits,
) -> Result<(), TemplateUnpackError> {
    let compressed = CompressedLimitReader::new(reader, limits.max_compressed_bytes);
    let mut decoder =
        zstd::stream::read::Decoder::new(compressed).map_err(TemplateUnpackError::invalid)?;
    // Pin zstd's current 128 MiB streaming-decoder default so a dependency
    // default change cannot let an object advertise an unbounded window.
    decoder
        .window_log_max(MAX_ZSTD_WINDOW_LOG)
        .map_err(TemplateUnpackError::invalid)?;
    let decoder = decoder.single_frame();
    let phase = Rc::new(Cell::new(ReadPhase::Metadata));
    let mut decompressed = DecompressedLimitReader::new(decoder, limits, Rc::clone(&phase));

    // Inspect the first raw header before tar can consume extension entries on
    // the caller's behalf. The producer schema starts directly with the
    // template member, so PAX and GNU long-name indirection are invalid.
    let mut first_header = [0u8; TAR_BLOCK_BYTES as usize];
    decompressed
        .read_exact(&mut first_header)
        .map_err(TemplateUnpackError::invalid)?;
    validate_first_header(&first_header, expected_template_bytes)?;

    let mut archive = tar::Archive::new(PrefixReader::new(first_header, decompressed));
    {
        let mut entries = archive.entries().map_err(TemplateUnpackError::invalid)?;
        {
            let mut entry = entries
                .next()
                .ok_or_else(|| TemplateUnpackError::invalid_message("template archive is empty"))?
                .map_err(TemplateUnpackError::invalid)?;

            let kind = entry.header().entry_type();
            if !matches!(kind, tar::EntryType::Regular | tar::EntryType::GNUSparse) {
                return Err(TemplateUnpackError::invalid_message(format!(
                    "template archive has unsupported entry type {kind:?}"
                )));
            }
            if entry.header().path_bytes().as_ref() != TEMPLATE_FILE.as_bytes()
                || entry.path_bytes().as_ref() != TEMPLATE_FILE.as_bytes()
            {
                return Err(TemplateUnpackError::invalid_message(
                    "template archive must contain top-level template.ext4",
                ));
            }
            if entry.size() != expected_template_bytes
                || entry
                    .header()
                    .size()
                    .map_err(TemplateUnpackError::invalid)?
                    != expected_template_bytes
            {
                return Err(TemplateUnpackError::invalid_message(format!(
                    "template archive logical size does not match expected {expected_template_bytes} bytes"
                )));
            }

            phase.set(ReadPhase::Payload);
            match entry.unpack_in(staging) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(TemplateUnpackError::invalid_message(
                        "template archive path was rejected during extraction",
                    ));
                }
                Err(error) if is_local_unpack_error(&error) => {
                    return Err(TemplateUnpackError::Local(R2Error::Io(error)));
                }
                Err(error) => return Err(TemplateUnpackError::invalid(error)),
            }
        }

        phase.set(ReadPhase::Metadata);
        if entries
            .next()
            .transpose()
            .map_err(TemplateUnpackError::invalid)?
            .is_some()
        {
            return Err(TemplateUnpackError::invalid_message(
                "template archive contains more than one member",
            ));
        }
    }

    // tar stops after consuming the first zero header. Require exactly the
    // producer's second zero header, then the end of the single zstd frame.
    let prefix_reader = archive.into_inner();
    let mut decompressed = prefix_reader.into_inner();
    let mut trailer = [0u8; TAR_BLOCK_BYTES as usize];
    decompressed
        .read_exact(&mut trailer)
        .map_err(TemplateUnpackError::invalid)?;
    if trailer.iter().any(|byte| *byte != 0) {
        return Err(TemplateUnpackError::invalid_message(
            "template archive has an invalid tar trailer",
        ));
    }
    let mut extra = [0u8; 1];
    if decompressed
        .read(&mut extra)
        .map_err(TemplateUnpackError::invalid)?
        != 0
    {
        return Err(TemplateUnpackError::invalid_message(
            "template archive has trailing decompressed data",
        ));
    }

    let decoder = decompressed.into_inner();
    let buffered_compressed = decoder.finish();
    if !buffered_compressed.buffer().is_empty() {
        return Err(TemplateUnpackError::invalid_message(
            "template archive has trailing compressed data",
        ));
    }
    let mut compressed = buffered_compressed.into_inner();
    if compressed
        .read(&mut extra)
        .map_err(TemplateUnpackError::invalid)?
        != 0
    {
        return Err(TemplateUnpackError::invalid_message(
            "template archive has trailing compressed data",
        ));
    }

    Ok(())
}

fn validate_first_header(
    bytes: &[u8; TAR_BLOCK_BYTES as usize],
    expected_template_bytes: u64,
) -> Result<(), TemplateUnpackError> {
    if bytes.iter().all(|byte| *byte == 0) {
        return Err(TemplateUnpackError::invalid_message(
            "template archive is empty",
        ));
    }
    let header = tar::Header::from_byte_slice(bytes);
    let kind = header.entry_type();
    if !matches!(kind, tar::EntryType::Regular | tar::EntryType::GNUSparse) {
        return Err(TemplateUnpackError::invalid_message(format!(
            "template archive starts with unsupported entry type {kind:?}"
        )));
    }
    if header.path_bytes().as_ref() != TEMPLATE_FILE.as_bytes() {
        return Err(TemplateUnpackError::invalid_message(
            "template archive must start with top-level template.ext4",
        ));
    }
    if header.size().map_err(TemplateUnpackError::invalid)? != expected_template_bytes {
        return Err(TemplateUnpackError::invalid_message(format!(
            "template archive logical size does not match expected {expected_template_bytes} bytes"
        )));
    }
    Ok(())
}

fn is_local_unpack_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::AlreadyExists
            | io::ErrorKind::WriteZero
            | io::ErrorKind::StorageFull
            | io::ErrorKind::QuotaExceeded
            | io::ErrorKind::FileTooLarge
            | io::ErrorKind::ReadOnlyFilesystem
            | io::ErrorKind::IsADirectory
            | io::ErrorKind::NotADirectory
    )
}

/// Stream one bounded template archive from an async reader into `staging`.
/// Caller creates and cleans the staging directory.
pub(super) async fn unpack_template_into_staging<R>(
    reader: R,
    staging: &Path,
    expected_template_bytes: u64,
    limits: TemplateArchiveLimits,
) -> Result<(), TemplateUnpackError>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let staging_for_blocking = staging.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let sync_reader = tokio_util::io::SyncIoBridge::new(reader);
        unpack_template_from_reader(
            sync_reader,
            &staging_for_blocking,
            expected_template_bytes,
            limits,
        )
    })
    .await
    .map_err(|error| TemplateUnpackError::Local(R2Error::Io(io_other(error))))?
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn compressed_reader_stops_at_actual_byte_limit() {
        let mut reader = CompressedLimitReader::new(Cursor::new(b"abcd"), 3);
        let mut output = Vec::new();

        let error = reader.read_to_end(&mut output).unwrap_err();

        assert_eq!(output, b"abc");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn decompressed_reader_bounds_high_ratio_zstd_output() {
        let compressed = zstd::stream::encode_all(Cursor::new(vec![0u8; 4096]), 1).unwrap();
        let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed)).unwrap();
        let phase = Rc::new(Cell::new(ReadPhase::Payload));
        let limits = TemplateArchiveLimits {
            max_decompressed_bytes: 1024,
            max_compressed_bytes: u64::MAX,
        };
        let mut reader = DecompressedLimitReader::new(decoder, limits, phase);
        let mut output = Vec::new();

        let error = reader.read_to_end(&mut output).unwrap_err();

        assert_eq!(output.len(), 1024);
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn archive_limit_arithmetic_rejects_overflow() {
        let error = TemplateArchiveLimits::new(u64::MAX).unwrap_err();

        assert!(matches!(error, R2Error::Io(_)));
    }

    #[test]
    fn decoder_rejects_window_larger_than_explicit_limit() {
        // Zstd frame header with no content size and a 2^28-byte window.
        let frame = [0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x90];
        let staging = tempfile::tempdir().unwrap();

        let error = unpack_template_from_reader(
            Cursor::new(frame),
            staging.path(),
            0,
            TemplateArchiveLimits::new(0).unwrap(),
        )
        .unwrap_err();

        assert!(matches!(error, TemplateUnpackError::Invalid(_)));
    }

    #[test]
    fn second_member_payload_is_not_unpacked() {
        let encoder = zstd::stream::write::Encoder::new(Vec::new(), 1).unwrap();
        let mut builder = tar::Builder::new(encoder);
        for (name, contents) in [
            (TEMPLATE_FILE, b"hello".as_slice()),
            ("extra.txt", b"must not unpack".as_slice()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_path(name).unwrap();
            header.set_mode(0o644);
            header.set_size(contents.len() as u64);
            header.set_cksum();
            builder.append(&header, Cursor::new(contents)).unwrap();
        }
        let encoder = builder.into_inner().unwrap();
        let archive = encoder.finish().unwrap();
        let staging = tempfile::tempdir().unwrap();

        let error = unpack_template_from_reader(
            Cursor::new(archive),
            staging.path(),
            5,
            TemplateArchiveLimits::new(5).unwrap(),
        )
        .unwrap_err();

        assert!(matches!(error, TemplateUnpackError::Invalid(_)));
        assert_eq!(
            std::fs::read(staging.path().join(TEMPLATE_FILE)).unwrap(),
            b"hello"
        );
        assert!(!staging.path().join("extra.txt").exists());
    }

    #[test]
    fn extraction_failure_on_local_staging_path_is_local() {
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), b"hello").unwrap();
        let mut archive = Vec::new();
        pack_template_to_writer(&mut archive, source.path()).unwrap();
        let staging_file = tempfile::NamedTempFile::new().unwrap();

        let error = unpack_template_from_reader(
            Cursor::new(archive),
            staging_file.path(),
            5,
            TemplateArchiveLimits::new(5).unwrap(),
        )
        .unwrap_err();

        assert!(matches!(error, TemplateUnpackError::Local(_)));
    }
}
