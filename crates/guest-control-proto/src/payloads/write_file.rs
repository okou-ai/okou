use super::truncate_utf8_to_u16_bytes;
use crate::error::ProtocolError;
use crate::frame::encode_into;
use crate::read::{
    checked_payload_len_add, ensure_payload_fits_message, ensure_u16_count, ensure_u16_len,
    ensure_u32_len, expect_consumed, read_slice, read_str, read_u8, read_u16, read_u32,
};
use crate::wire::{
    MSG_WRITE_FILE, MSG_WRITE_FILES, MSG_WRITE_PRIVATE_FILES, WRITE_FILE_FLAG_APPEND,
    WRITE_FILE_FLAG_PRIVATE, WRITE_FILE_FLAG_SUDO,
};

struct EncodedWriteFilePayload<'a> {
    path_len: u16,
    path_bytes: &'a [u8],
    content_len: u32,
    content: &'a [u8],
    flags: u8,
    payload_len: usize,
}

struct EncodedWriteFilesEntry<'a> {
    path_len: u16,
    path_bytes: &'a [u8],
    content_len: u32,
    content: &'a [u8],
}

struct EncodedWriteFilesPayload<'a> {
    file_count: u16,
    entries: Vec<EncodedWriteFilesEntry<'a>>,
    payload_len: usize,
}

/// One file entry in a `write_files` or `write_private_files` batch payload.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WriteFileBatchEntry<'a> {
    /// Guest path to create or replace.
    pub path: &'a str,
    /// Bytes to write to the guest path.
    pub content: &'a [u8],
}

/// Encode write_file payload: `[2B path_len][path][1B flags][4B content_len][content]`.
///
/// Returns `Err` if path exceeds 65535 bytes (u16 field limit).
/// Returns `Err` if the payload cannot fit in a protocol frame.
pub fn encode_write_file(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    encode_write_file_flags(path, content, sudo, append, false)
}

/// Validate a write_file payload without encoding it.
pub fn validate_write_file(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<(), ProtocolError> {
    validate_write_file_payload(path, content, sudo, append, false).map(|_| ())
}

/// Encode a full write_file frame into `frame`.
///
/// The resulting frame uses the same bytes as
/// `encode(MSG_WRITE_FILE, seq, &encode_write_file(...))` without allocating
/// separate payload and frame vectors.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `path` or `content` cannot fit its wire length
/// field, or the encoded payload exceeds the maximum message size.
///
/// `frame` is cleared before payload validation. Consequently, a validation
/// error leaves the destination empty. After validation succeeds, the shared
/// frame encoder also clears `frame` before checking the frame size and writing
/// the encoded bytes.
pub fn encode_write_file_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
) -> Result<(), ProtocolError> {
    encode_write_file_frame_flags_into(frame, seq, path, content, sudo, append, false)
}

/// Encode a private write_file payload.
pub fn encode_private_write_file(
    path: &str,
    content: &[u8],
    append: bool,
) -> Result<Vec<u8>, ProtocolError> {
    encode_write_file_flags(path, content, false, append, true)
}

/// Validate a private write_file payload without encoding it.
pub fn validate_private_write_file(
    path: &str,
    content: &[u8],
    append: bool,
) -> Result<(), ProtocolError> {
    validate_write_file_payload(path, content, false, append, true).map(|_| ())
}

/// Encode a full private write_file frame into `frame`.
///
/// The resulting frame uses the same bytes as
/// `encode(MSG_WRITE_FILE, seq, &encode_private_write_file(...))` without
/// allocating separate payload and frame vectors.
///
/// # Errors
///
/// Returns [`ProtocolError`] if `path` or `content` cannot fit its wire length
/// field, or the encoded payload exceeds the maximum message size.
///
/// `frame` is cleared before payload validation. Consequently, a validation
/// error leaves the destination empty. After validation succeeds, the shared
/// frame encoder also clears `frame` before checking the frame size and writing
/// the encoded bytes.
pub fn encode_private_write_file_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    path: &str,
    content: &[u8],
    append: bool,
) -> Result<(), ProtocolError> {
    encode_write_file_frame_flags_into(frame, seq, path, content, false, append, true)
}

/// Encode write_files payload:
/// `[2B file_count]` followed by `[2B path_len][path][4B content_len][content]` for each file.
///
/// # Errors
///
/// Returns [`ProtocolError`] if the batch is empty, contains more than 65,535
/// entries because `file_count` is encoded as `u16`, any path exceeds the
/// `u16` length-field limit, any content exceeds the `u32` length-field limit,
/// or the encoded payload cannot fit in one protocol frame.
pub fn encode_write_files(files: &[WriteFileBatchEntry<'_>]) -> Result<Vec<u8>, ProtocolError> {
    let encoded = validate_write_files_payload(files)?;

    let mut p = Vec::with_capacity(encoded.payload_len);
    append_write_files_payload(&mut p, &encoded);
    debug_assert_eq!(p.len(), encoded.payload_len);
    Ok(p)
}

/// Validate a write_files payload without encoding it.
///
/// This applies the same input constraints documented by [`encode_write_files`].
pub fn validate_write_files(files: &[WriteFileBatchEntry<'_>]) -> Result<(), ProtocolError> {
    validate_write_files_payload(files).map(|_| ())
}

/// Encode a full write_files frame into `frame`.
///
/// The resulting frame uses the same bytes as
/// `encode(MSG_WRITE_FILES, seq, &encode_write_files(...))` without allocating
/// separate payload and frame vectors.
///
/// This applies the same input constraints documented by [`encode_write_files`].
///
/// # Errors
///
/// Returns [`ProtocolError`] if `files` is empty, the file count exceeds its
/// wire length field, a path or content length exceeds its wire length field,
/// or the encoded payload exceeds the maximum message size.
///
/// `frame` is cleared before payload validation. Consequently, a validation
/// error leaves the destination empty. After validation succeeds, the shared
/// frame encoder also clears `frame` before checking the frame size and writing
/// the encoded bytes.
pub fn encode_write_files_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    files: &[WriteFileBatchEntry<'_>],
) -> Result<(), ProtocolError> {
    frame.clear();
    let encoded = validate_write_files_payload(files)?;
    encode_into(frame, MSG_WRITE_FILES, seq, encoded.payload_len, |frame| {
        append_write_files_payload(frame, &encoded);
    })
}

/// Encode a full private write_files frame into `frame`.
///
/// The payload bytes and validation rules match
/// [`encode_write_files_frame_into`]; the request message type selects
/// runtime-private semantics for every entry.
///
/// # Errors
///
/// Returns [`ProtocolError`] under the same conditions as
/// [`encode_write_files_frame_into`].
pub fn encode_private_write_files_frame_into(
    frame: &mut Vec<u8>,
    seq: u32,
    files: &[WriteFileBatchEntry<'_>],
) -> Result<(), ProtocolError> {
    frame.clear();
    let encoded = validate_write_files_payload(files)?;
    encode_into(
        frame,
        MSG_WRITE_PRIVATE_FILES,
        seq,
        encoded.payload_len,
        |frame| append_write_files_payload(frame, &encoded),
    )
}

fn validate_write_files_payload<'a>(
    files: &[WriteFileBatchEntry<'a>],
) -> Result<EncodedWriteFilesPayload<'a>, ProtocolError> {
    if files.is_empty() {
        return Err(ProtocolError::InvalidPayload(
            "write_files file count must be positive",
        ));
    }
    let file_count = ensure_u16_count("file_count", files.len())?;
    let mut payload_len = 2;
    let mut encoded_entries = Vec::with_capacity(files.len());
    for file in files {
        let path_bytes = file.path.as_bytes();
        let path_len = ensure_u16_len("path", path_bytes.len())?;
        let content_len = ensure_u32_len("content", file.content.len())?;
        payload_len = checked_payload_len_add(payload_len, 2)?;
        payload_len = checked_payload_len_add(payload_len, path_bytes.len())?;
        payload_len = checked_payload_len_add(payload_len, 4)?;
        payload_len = checked_payload_len_add(payload_len, file.content.len())?;
        encoded_entries.push(EncodedWriteFilesEntry {
            path_len,
            path_bytes,
            content_len,
            content: file.content,
        });
    }
    ensure_payload_fits_message(payload_len)?;
    Ok(EncodedWriteFilesPayload {
        file_count,
        entries: encoded_entries,
        payload_len,
    })
}

fn append_write_files_payload(p: &mut Vec<u8>, encoded: &EncodedWriteFilesPayload<'_>) {
    p.extend_from_slice(&encoded.file_count.to_be_bytes());
    for entry in &encoded.entries {
        p.extend_from_slice(&entry.path_len.to_be_bytes());
        p.extend_from_slice(entry.path_bytes);
        p.extend_from_slice(&entry.content_len.to_be_bytes());
        p.extend_from_slice(entry.content);
    }
}

fn encode_write_file_flags(
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
    private: bool,
) -> Result<Vec<u8>, ProtocolError> {
    let encoded = validate_write_file_payload(path, content, sudo, append, private)?;

    let mut p = Vec::with_capacity(encoded.payload_len);
    append_write_file_payload(&mut p, &encoded);
    debug_assert_eq!(p.len(), encoded.payload_len);
    Ok(p)
}

fn encode_write_file_frame_flags_into(
    frame: &mut Vec<u8>,
    seq: u32,
    path: &str,
    content: &[u8],
    sudo: bool,
    append: bool,
    private: bool,
) -> Result<(), ProtocolError> {
    frame.clear();
    let encoded = validate_write_file_payload(path, content, sudo, append, private)?;
    encode_into(frame, MSG_WRITE_FILE, seq, encoded.payload_len, |frame| {
        append_write_file_payload(frame, &encoded);
    })
}

fn validate_write_file_payload<'a>(
    path: &'a str,
    content: &'a [u8],
    sudo: bool,
    append: bool,
    private: bool,
) -> Result<EncodedWriteFilePayload<'a>, ProtocolError> {
    let path_bytes = path.as_bytes();
    let path_len = ensure_u16_len("path", path_bytes.len())?;
    let content_len = ensure_u32_len("content", content.len())?;
    let mut payload_len = checked_payload_len_add(2, path_bytes.len())?;
    payload_len = checked_payload_len_add(payload_len, 1 + 4)?;
    payload_len = checked_payload_len_add(payload_len, content.len())?;
    ensure_payload_fits_message(payload_len)?;

    let mut flags = 0u8;
    if sudo {
        flags |= WRITE_FILE_FLAG_SUDO;
    }
    if append {
        flags |= WRITE_FILE_FLAG_APPEND;
    }
    if private {
        flags |= WRITE_FILE_FLAG_PRIVATE;
    }
    Ok(EncodedWriteFilePayload {
        path_len,
        path_bytes,
        content_len,
        content,
        flags,
        payload_len,
    })
}

fn append_write_file_payload(p: &mut Vec<u8>, encoded: &EncodedWriteFilePayload<'_>) {
    p.extend_from_slice(&encoded.path_len.to_be_bytes());
    p.extend_from_slice(encoded.path_bytes);
    p.push(encoded.flags);
    p.extend_from_slice(&encoded.content_len.to_be_bytes());
    p.extend_from_slice(encoded.content);
}

/// Encode write_file_result payload: `[1B success][2B error_len][error]`.
///
/// Error message is truncated to at most 65535 bytes at a UTF-8 boundary.
pub fn encode_write_file_result(success: bool, error: &str) -> Vec<u8> {
    let (err, err_len) = truncate_utf8_to_u16_bytes(error);
    let mut p = Vec::with_capacity(3 + err_len as usize);
    p.push(u8::from(success));
    p.extend_from_slice(&err_len.to_be_bytes());
    p.extend_from_slice(err);
    p
}

/// Encode write_files_result payload: `[1B success][2B error_len][error]`.
///
/// Like [`encode_write_file_result`], the error message is truncated to at most
/// 65535 bytes at a UTF-8 boundary.
pub fn encode_write_files_result(success: bool, error: &str) -> Vec<u8> {
    encode_write_file_result(success, error)
}

/// Decode write_file payload. Returns `(path, content, sudo, append, private)`.
pub fn decode_write_file(payload: &[u8]) -> Result<(&str, &[u8], bool, bool, bool), ProtocolError> {
    let mut offset = 0;
    let path_len = read_u16(payload, &mut offset, "write_file too short")? as usize;
    let path = read_str(
        payload,
        &mut offset,
        path_len,
        "write_file path truncated",
        "invalid UTF-8 in path",
    )?;
    let flags = read_u8(payload, &mut offset, "write_file too short")?;
    let known_flags = WRITE_FILE_FLAG_SUDO | WRITE_FILE_FLAG_APPEND | WRITE_FILE_FLAG_PRIVATE;
    if flags & !known_flags != 0 {
        return Err(ProtocolError::InvalidPayload("write_file unknown flags"));
    }
    if flags & WRITE_FILE_FLAG_PRIVATE != 0 && flags & WRITE_FILE_FLAG_SUDO != 0 {
        return Err(ProtocolError::InvalidPayload(
            "write_file private flag cannot be combined with sudo",
        ));
    }
    let content_len = read_u32(payload, &mut offset, "write_file too short")? as usize;
    let content = read_slice(
        payload,
        &mut offset,
        content_len,
        "write_file content truncated",
    )?;
    expect_consumed(payload, offset, "write_file trailing bytes")?;

    Ok((
        path,
        content,
        (flags & WRITE_FILE_FLAG_SUDO) != 0,
        (flags & WRITE_FILE_FLAG_APPEND) != 0,
        (flags & WRITE_FILE_FLAG_PRIVATE) != 0,
    ))
}

/// Decode write_files payload.
///
/// Returns borrowed file entries backed by `payload`.
pub fn decode_write_files(payload: &[u8]) -> Result<Vec<WriteFileBatchEntry<'_>>, ProtocolError> {
    let mut offset = 0;
    let file_count = read_u16(payload, &mut offset, "write_files too short")? as usize;
    if file_count == 0 {
        return Err(ProtocolError::InvalidPayload(
            "write_files file count must be positive",
        ));
    }

    let mut files = Vec::with_capacity(file_count);
    for _ in 0..file_count {
        let path_len = read_u16(payload, &mut offset, "write_files path_len truncated")? as usize;
        let path = read_str(
            payload,
            &mut offset,
            path_len,
            "write_files path truncated",
            "invalid UTF-8 in write_files path",
        )?;
        let content_len =
            read_u32(payload, &mut offset, "write_files content_len truncated")? as usize;
        let content = read_slice(
            payload,
            &mut offset,
            content_len,
            "write_files content truncated",
        )?;
        files.push(WriteFileBatchEntry { path, content });
    }
    expect_consumed(payload, offset, "write_files trailing bytes")?;

    Ok(files)
}

/// Decode write_file_result payload. Returns `(success, error)`.
pub fn decode_write_file_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    let mut offset = 0;
    let success = match read_u8(payload, &mut offset, "write_file_result too short")? {
        0 => false,
        1 => true,
        _ => {
            return Err(ProtocolError::InvalidPayload(
                "write_file_result invalid success",
            ));
        }
    };
    let err_len = read_u16(payload, &mut offset, "write_file_result too short")? as usize;
    let error = read_str(
        payload,
        &mut offset,
        err_len,
        "write_file_result error truncated",
        "invalid UTF-8 in error",
    )?;
    expect_consumed(payload, offset, "write_file_result trailing bytes")?;

    Ok((success, error))
}

/// Decode write_files_result payload. Returns `(success, error)`.
pub fn decode_write_files_result(payload: &[u8]) -> Result<(bool, &str), ProtocolError> {
    decode_write_file_result(payload)
}

#[cfg(test)]
mod tests;
