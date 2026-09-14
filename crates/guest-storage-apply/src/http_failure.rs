use crate::error::DownloadError;
use std::fmt::Write;
use ureq::http::{HeaderMap, Response, Uri};

const ERROR_BODY_LIMIT: u64 = 4096;

pub(crate) fn from_response(url: &str, mut response: Response<ureq::Body>) -> DownloadError {
    let status = response.status().as_u16();
    let mut message = format!("HTTP status {status}");
    append_request_metadata(&mut message, url);
    append_header(&mut message, response.headers(), "x-amz-request-id");
    append_header(&mut message, response.headers(), "cf-ray");

    // Error bodies are untrusted and may contain credentials, object keys or
    // signed URLs. Retain only recognized diagnostic fields, never raw XML or
    // parser errors. Reading stays inside the original request's global deadline.
    match response
        .body_mut()
        .with_config()
        .limit(ERROR_BODY_LIMIT)
        .read_to_string()
    {
        Ok(body) => append_s3_error(&mut message, &body),
        Err(ureq::Error::BodyExceedsLimit(_)) => message.push_str(" response_body=too_large"),
        Err(_) => message.push_str(" response_body=unavailable"),
    }

    DownloadError::new(message)
}

fn append_request_metadata(message: &mut String, url: &str) {
    let Ok(uri) = url.parse::<Uri>() else {
        return;
    };
    if let Some(host) = uri.host() {
        let _ = write!(message, " request_host={host}");
    }
    let query = uri.query().unwrap_or_default();
    let parameter = |name| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == name).then_some(value)
        })
    };
    if let Some(value) = parameter("X-Amz-Date").filter(|value| is_signing_date(value)) {
        let _ = write!(message, " signing_date={value}");
    }
    if let Some(seconds) = parameter("X-Amz-Expires").and_then(|value| value.parse::<u32>().ok()) {
        let _ = write!(message, " expires_seconds={seconds}");
    }
}

fn is_signing_date(value: &str) -> bool {
    value.len() == 16
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 => byte == b'T',
            15 => byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}

fn append_header(message: &mut String, headers: &HeaderMap, name: &str) {
    if let Some(value) = headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        let _ = write!(message, " {name}={value}");
    }
}

fn append_s3_error(message: &mut String, body: &str) {
    if body.is_empty() {
        message.push_str(" response_body=empty");
        return;
    }
    let Ok(document) = roxmltree::Document::parse(body) else {
        message.push_str(" response_body=unrecognized");
        return;
    };
    let root = document.root_element();
    if root.tag_name().name() != "Error" {
        message.push_str(" response_body=unrecognized");
        return;
    }
    let code = root
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "Code")
        .and_then(|node| node.text())
        .map(str::trim)
        .filter(|code| {
            matches!(
                *code,
                "AccessDenied"
                    | "ExpiredRequest"
                    | "RequestExpired"
                    | "ExpiredToken"
                    | "SignatureDoesNotMatch"
                    | "RequestTimeTooSkewed"
                    | "InvalidAccessKeyId"
                    | "InvalidToken"
                    | "AuthorizationHeaderMalformed"
                    | "NoSuchKey"
                    | "NoSuchBucket"
                    | "InternalError"
                    | "ServiceUnavailable"
                    | "SlowDown"
            )
        })
        .unwrap_or("unrecognized");
    let _ = write!(message, " s3_code={code}");

    // Some S3-compatible services report expiry as AccessDenied with a standard
    // Message rather than a distinct Code. Do not echo arbitrary Message text.
    if root.children().any(|node| {
        node.is_element()
            && node.tag_name().name() == "Message"
            && node.text().is_some_and(|text| {
                matches!(
                    text.trim().trim_end_matches('.'),
                    "Request has expired" | "The provided token has expired"
                )
            })
    }) {
        message.push_str(" s3_message_kind=request_expired");
    }
}
