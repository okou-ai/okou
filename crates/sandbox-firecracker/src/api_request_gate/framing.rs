use std::future::{Future, poll_fn};
use std::io;

use tokio::io::AsyncReadExt;
use tokio::net::UnixStream;
use tokio::sync::oneshot;

use super::{PendingRequestBody, Transition};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 64 * 1024;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn first_line(bytes: &[u8]) -> io::Result<&[u8]> {
    let end = bytes
        .windows(2)
        .position(|value| value == b"\r\n")
        .ok_or_else(|| invalid("missing HTTP start-line terminator"))?;
    bytes
        .get(..end)
        .ok_or_else(|| invalid("invalid HTTP start-line bound"))
}

pub(super) async fn read_frame(
    stream: &mut UnixStream,
    response: bool,
    mut body_pending: Option<oneshot::Sender<PendingRequestBody>>,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            let end = index + 4;
            if end > MAX_HEADER_BYTES {
                return Err(invalid("HTTP headers exceed gate bound"));
            }
            break end;
        }
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(invalid("HTTP headers exceed gate bound"));
        }
        let count = stream.read(&mut chunk).await?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated HTTP headers",
            ));
        }
        bytes.extend_from_slice(
            chunk
                .get(..count)
                .ok_or_else(|| invalid("invalid read count"))?,
        );
    };
    let headers = std::str::from_utf8(
        bytes
            .get(..header_end)
            .ok_or_else(|| invalid("missing headers"))?,
    )
    .map_err(|_| invalid("HTTP headers are not UTF-8"))?;
    let mut length = None;
    for line in headers
        .split("\r\n")
        .skip(1)
        .filter(|line| !line.is_empty())
    {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| invalid("malformed HTTP header"))?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        {
            return Err(invalid("invalid HTTP header name"));
        }
        if !value
            .bytes()
            .all(|byte| byte == b'\t' || (b' '..=b'~').contains(&byte))
        {
            return Err(invalid("invalid HTTP header value"));
        }
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(invalid("transfer encoding is unsupported by request gate"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            let value = value.trim_matches([' ', '\t']);
            if length.is_some()
                || value.is_empty()
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(invalid("ambiguous or invalid Content-Length"));
            }
            length = Some(
                value
                    .parse::<usize>()
                    .map_err(|_| invalid("invalid Content-Length"))?,
            );
        }
    }
    let length = match length {
        Some(length) => length,
        None if !response => 0,
        None if matches!(response_status(&bytes)?, 204 | 304) => 0,
        None => return Err(invalid("backend response needs Content-Length")),
    };
    if length > MAX_BODY_BYTES {
        return Err(invalid("HTTP body exceeds gate bound"));
    }
    if response && matches!(response_status(&bytes)?, 204 | 304) && length != 0 {
        return Err(invalid("body is forbidden for this response status"));
    }
    let end = header_end + length;
    if bytes.len() > end {
        return Err(invalid("buffered bytes follow the single HTTP frame"));
    }
    while bytes.len() < end {
        let remaining = (end - bytes.len()).min(chunk.len());
        let buffer = chunk
            .get_mut(..remaining)
            .ok_or_else(|| invalid("invalid body bound"))?;
        let read = stream.read(buffer);
        tokio::pin!(read);
        let count = poll_fn(|cx| {
            let result = read.as_mut().poll(cx);
            if result.is_pending()
                && bytes.len() > header_end
                && let Some(observer) = body_pending.take()
            {
                let _ = observer.send(PendingRequestBody {
                    raw: bytes.clone(),
                    remaining_body_bytes: end - bytes.len(),
                });
            }
            result
        })
        .await?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated HTTP body",
            ));
        }
        bytes.extend_from_slice(
            buffer
                .get(..count)
                .ok_or_else(|| invalid("invalid body read"))?,
        );
    }
    Ok(bytes)
}

pub(super) fn validate_request(bytes: &[u8], transition: Transition) -> io::Result<()> {
    let header_end = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .ok_or_else(|| invalid("missing request headers"))?
        + 4;
    if first_line(bytes)? != b"PATCH /vm HTTP/1.1" {
        return Err(invalid("request is not the expected PATCH /vm"));
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct VmState {
        state: String,
    }
    let body: VmState = serde_json::from_slice(
        bytes
            .get(header_end..)
            .ok_or_else(|| invalid("missing request body"))?,
    )
    .map_err(|_| invalid("invalid transition JSON"))?;
    let expected = match transition {
        Transition::Resume => "Resumed",
        Transition::Pause => "Paused",
    };
    if body.state != expected {
        return Err(invalid("request does not match the selected transition"));
    }
    Ok(())
}

pub(super) fn response_status(bytes: &[u8]) -> io::Result<u16> {
    let line = first_line(bytes)?;
    let text = std::str::from_utf8(line).map_err(|_| invalid("invalid HTTP status"))?;
    let mut parts = text.splitn(3, ' ');
    if parts.next() != Some("HTTP/1.1") {
        return Err(invalid("unsupported backend HTTP version"));
    }
    let code = parts
        .next()
        .ok_or_else(|| invalid("missing HTTP status code"))?;
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid("invalid HTTP status code"));
    }
    let status: u16 = code
        .parse()
        .map_err(|_| invalid("invalid HTTP status code"))?;
    if !(200..=599).contains(&status) {
        return Err(invalid("backend response is not terminal"));
    }
    let reason = parts
        .next()
        .ok_or_else(|| invalid("missing HTTP reason separator"))?;
    if !reason.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
        return Err(invalid("invalid HTTP reason phrase"));
    }
    Ok(status)
}
