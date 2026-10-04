//! Non-secret object identity for attributes on existing R2 download logs.
//!
//! This is diagnostic classification, not URL validation or network policy.
//! Unknown endpoints (including Workers and CDNs) have no inferred identity.

use serde::Serialize;

/// The bucket and complete object key, never a URL or signing parameters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct R2DownloadIdentity {
    /// The R2 bucket name.
    pub r2_bucket: String,
    /// The object key, decoded exactly once without form-style `+` conversion.
    pub r2_key: String,
}

impl R2DownloadIdentity {
    /// Recognize native virtual-host or path-style R2 HTTP(S) download URLs.
    ///
    /// Both default and `eu`/`fedramp` endpoints are supported. Malformed,
    /// non-native, non-UTF-8 and over-1024-byte object keys omit attributes.
    /// Query, fragment and authority userinfo are never retained.
    pub fn from_url(url: &str) -> Option<Self> {
        // Native authority plus any valid encoded key fits this prefix. Large
        // query/fragment suffixes must not cause unbounded diagnostic parsing.
        let url = url.get(..url.len().min(4096))?;
        let rest = if url.get(..8)?.eq_ignore_ascii_case("https://") {
            &url[8..]
        } else if url.get(..7)?.eq_ignore_ascii_case("http://") {
            &url[7..]
        } else {
            return None;
        };
        let (authority, path) = rest.split_once('/')?;
        if authority.len() > 253 || authority.contains(['@', '?', '#', '\\']) {
            return None;
        }
        let host = match authority.split_once(':') {
            Some((host, port))
                if port.bytes().all(|byte| byte.is_ascii_digit())
                    && port.parse::<u16>().ok().is_some_and(|port| port > 0) =>
            {
                host
            }
            Some(_) => return None,
            None => authority,
        }
        .to_ascii_lowercase();
        let prefix = host.strip_suffix(".r2.cloudflarestorage.com")?;
        let prefix = prefix
            .strip_suffix(".eu")
            .or_else(|| prefix.strip_suffix(".fedramp"))
            .unwrap_or(prefix);
        let (bucket, account) = prefix.rsplit_once('.').unwrap_or(("", prefix));
        if account.len() != 32 || !account.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let path = path.split(['?', '#']).next()?;
        let (bucket, key) = if bucket.is_empty() {
            path.split_once('/')?
        } else {
            (bucket, path)
        };
        if !(3..=63).contains(&bucket.len())
            || !bucket.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
            })
        {
            return None;
        }
        Some(Self {
            r2_bucket: bucket.to_owned(),
            r2_key: decode_object_key(key)?,
        })
    }
}

fn decode_object_key(key: &str) -> Option<String> {
    if key.is_empty() || key.len() > 3 * 1024 || key.contains('\\') {
        return None;
    }
    let mut decoded = Vec::with_capacity(key.len().min(1024));
    let mut bytes = key.bytes();
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            u8::try_from(high * 16 + low).ok()?
        } else {
            byte
        };
        decoded.push(byte);
        if decoded.len() > 1024 {
            return None;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn native_download_identity_excludes_credentials_and_decodes_once() {
        for host in [
            format!("example-bucket.{ACCOUNT}.r2.cloudflarestorage.com"),
            format!("example-bucket.{ACCOUNT}.eu.r2.cloudflarestorage.com"),
            format!("example-bucket.{ACCOUNT}.fedramp.r2.cloudflarestorage.com"),
        ] {
            let url = format!(
                "https://{host}/org/version/a%20b+%252F%2F%E4%B8%AD/archive.tar.gz?X-Amz-Signature=synthetic-secret#private-fragment"
            );
            let identity = R2DownloadIdentity::from_url(&url).unwrap();
            assert_eq!(identity.r2_bucket, "example-bucket");
            assert_eq!(identity.r2_key, "org/version/a b+%2F/中/archive.tar.gz");
            let serialized = serde_json::to_string(&identity).unwrap();
            assert!(!serialized.contains("synthetic-secret"));
            assert!(!serialized.contains("private-fragment"));
            assert!(!serialized.contains("X-Amz"));
        }
    }

    #[test]
    fn path_style_and_dotted_bucket_preserve_full_key() {
        for suffix in ["", ".eu", ".fedramp"] {
            let url = format!(
                "http://{ACCOUNT}{suffix}.r2.cloudflarestorage.com:8080/example-bucket/prefix/archive.tar.gz?signature=secret"
            );
            assert_eq!(
                R2DownloadIdentity::from_url(&url),
                Some(R2DownloadIdentity {
                    r2_bucket: "example-bucket".into(),
                    r2_key: "prefix/archive.tar.gz".into(),
                })
            );
        }
        let url = format!("https://dotted.bucket.{ACCOUNT}.r2.cloudflarestorage.com//key+");
        assert_eq!(R2DownloadIdentity::from_url(&url).unwrap().r2_key, "/key+");
    }

    #[test]
    fn unknown_malformed_and_oversized_sources_have_no_identity() {
        let native = format!("example-bucket.{ACCOUNT}.r2.cloudflarestorage.com");
        for url in [
            "file:///cache/hash/archive.tar.gz".into(),
            "https://example.com/key".into(),
            "https://r2.example.com/key".into(),
            format!("https://{native}.evil.example/key"),
            format!("https://user:password@{native}/key"),
            format!("https://{native}:bad/key"),
            format!("https://{native}:+443/key"),
            format!("https://{native}:0/key"),
            format!("https://{native}:65536/key"),
            format!("https://{native}/key%"),
            format!("https://{native}/key%GG"),
            format!("https://{native}/%FF"),
            format!("https://{native}/"),
            format!("https://{ACCOUNT}.r2.cloudflarestorage.com/example-bucket"),
            format!("https://{native}/{}", "a".repeat(1025)),
            format!("https://{native}/{}", "%41".repeat(1025)),
        ] {
            assert!(R2DownloadIdentity::from_url(&url).is_none(), "{url}");
        }
        let maximum = format!("https://{native}/{}", "%41".repeat(1024));
        assert_eq!(
            R2DownloadIdentity::from_url(&maximum).unwrap().r2_key.len(),
            1024
        );
        let large_query = format!("{maximum}?signature={}", "s".repeat(100_000));
        assert_eq!(
            R2DownloadIdentity::from_url(&large_query),
            R2DownloadIdentity::from_url(&maximum)
        );
    }
}
