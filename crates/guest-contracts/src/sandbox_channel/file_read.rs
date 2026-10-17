use super::{
    ChannelError, Operation, Params, ResultPayload, basename, count_limit, fs_read, handle, limits,
    object, raw_path,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;

fn offset(value: &str) -> Result<u64, ChannelError> {
    if value.is_empty()
        || value.len() > 19
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(ChannelError::InvalidRequest);
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= i64::MAX as u64)
        .ok_or(ChannelError::InvalidRequest)
}

fn length(value: &mut Value, minimum: u32) -> Result<(), ChannelError> {
    let field = value
        .get_mut("length")
        .ok_or(ChannelError::InvalidRequest)?;
    let number = field.as_f64().ok_or(ChannelError::InvalidRequest)?;
    if number < f64::from(minimum)
        || number > f64::from(limits::fs_read::MAX_CHUNK_BYTES)
        || number.fract() != 0.0
    {
        return Err(ChannelError::InvalidRequest);
    }
    // The checked finite range is at most 32 KiB, exactly representable in f64.
    *field = Value::from(number as u32);
    Ok(())
}

pub(super) fn params(operation: Operation, mut value: Value) -> Result<Params, ChannelError> {
    params_inner(operation, &mut value).map_err(|_| ChannelError::InvalidParams)
}

fn params_inner(operation: Operation, value: &mut Value) -> Result<Params, ChannelError> {
    match operation {
        Operation::FsReadOpen => {
            object(value, &["path", "mode"], &["path", "mode"])?;
            let parsed: fs_read::OpenParams =
                serde_json::from_value(value.take()).map_err(|_| ChannelError::InvalidRequest)?;
            if parsed.path.is_empty() {
                return Err(ChannelError::InvalidRequest);
            }
            raw_path(&parsed.path)?;
            Ok(Params::FsReadOpen(parsed))
        }
        Operation::FsRead => {
            object(
                value,
                &["handle", "offset", "length"],
                &["handle", "offset", "length"],
            )?;
            length(value, 1)?;
            let parsed: fs_read::ReadParams =
                serde_json::from_value(value.take()).map_err(|_| ChannelError::InvalidRequest)?;
            if !handle(&parsed.handle) {
                return Err(ChannelError::InvalidRequest);
            }
            offset(&parsed.offset)?;
            Ok(Params::FsRead(parsed))
        }
        Operation::FsReadFinish | Operation::FsReadClose => {
            object(value, &["handle"], &["handle"])?;
            let parsed: fs_read::HandleParams =
                serde_json::from_value(value.take()).map_err(|_| ChannelError::InvalidRequest)?;
            if !handle(&parsed.handle) {
                return Err(ChannelError::InvalidRequest);
            }
            Ok(if operation == Operation::FsReadFinish {
                Params::FsReadFinish(parsed)
            } else {
                Params::FsReadClose(parsed)
            })
        }
        _ => Err(ChannelError::UnknownOperation),
    }
}

pub(super) fn result(
    operation: Operation,
    mut value: Value,
) -> Result<ResultPayload, ChannelError> {
    let size = serde_json::to_vec(&value)
        .map_err(|_| ChannelError::InvalidRequest)?
        .len();
    if !count_limit(
        size.saturating_add(limits::RESPONSE_OVERHEAD_BYTES as usize),
        limits::fs_read::MAX_RESPONSE_BYTES,
    ) {
        return Err(ChannelError::InvalidRequest);
    }
    match operation {
        Operation::FsReadOpen => {
            let fields = &[
                "handle",
                "nameToken",
                "displayName",
                "fileSize",
                "selectedSize",
                "truncated",
            ];
            object(&value, fields, fields)?;
            let parsed: fs_read::OpenResult =
                serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
            let full = offset(&parsed.file_size)?;
            let selected = offset(&parsed.selected_size)?;
            if !handle(&parsed.handle)
                || selected > full
                || parsed.truncated != (selected < full)
                || parsed.display_name.is_empty()
                || !count_limit(
                    parsed.display_name.len(),
                    limits::fs::MAX_DISPLAY_NAME_BYTES,
                )
                || parsed.display_name.chars().any(char::is_control)
            {
                return Err(ChannelError::InvalidRequest);
            }
            basename(&parsed.name_token).map_err(|_| ChannelError::InvalidRequest)?;
            Ok(ResultPayload::FsReadOpen(parsed))
        }
        Operation::FsRead => {
            object(
                &value,
                &["offset", "length", "data"],
                &["offset", "length", "data"],
            )?;
            length(&mut value, 0)?;
            let parsed: fs_read::ReadResult =
                serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
            offset(&parsed.offset)?;
            if !count_limit(
                parsed.data.len(),
                4 * limits::fs_read::MAX_CHUNK_BYTES.div_ceil(3),
            ) {
                return Err(ChannelError::InvalidRequest);
            }
            let bytes = STANDARD
                .decode(&parsed.data)
                .map_err(|_| ChannelError::InvalidRequest)?;
            if bytes.len() != parsed.length as usize || STANDARD.encode(bytes) != parsed.data {
                return Err(ChannelError::InvalidRequest);
            }
            Ok(ResultPayload::FsRead(parsed))
        }
        Operation::FsReadFinish | Operation::FsReadClose => {
            object(&value, &[], &[])?;
            let parsed = serde_json::from_value(value).map_err(|_| ChannelError::InvalidRequest)?;
            Ok(if operation == Operation::FsReadFinish {
                ResultPayload::FsReadFinish(parsed)
            } else {
                ResultPayload::FsReadClose(parsed)
            })
        }
        _ => Err(ChannelError::UnknownOperation),
    }
}
