use super::*;

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

#[test]
fn native_key_excludes_signing_parameters_and_decodes_once() {
    for host in [
        format!("example-bucket.{ACCOUNT}.r2.cloudflarestorage.com"),
        format!("example-bucket.{ACCOUNT}.eu.r2.cloudflarestorage.com"),
        format!("example-bucket.{ACCOUNT}.fedramp.r2.cloudflarestorage.com"),
    ] {
        let url = format!(
            "https://{host}/org/version/a%20b+%252F%2F%E4%B8%AD/archive.tar.gz?X-Amz-Signature=synthetic-secret#private-fragment"
        );
        assert_eq!(
            key_from_url(&url).as_deref(),
            Some("org/version/a b+%2F/中/archive.tar.gz")
        );
    }
}

#[test]
fn path_style_and_dotted_bucket_preserve_full_key() {
    for suffix in ["", ".eu", ".fedramp"] {
        let url = format!(
            "http://{ACCOUNT}{suffix}.r2.cloudflarestorage.com:8080/example-bucket/prefix/archive.tar.gz?signature=secret"
        );
        assert_eq!(key_from_url(&url).as_deref(), Some("prefix/archive.tar.gz"));
    }
    let url = format!("https://dotted.bucket.{ACCOUNT}.r2.cloudflarestorage.com//key+");
    assert_eq!(key_from_url(&url).as_deref(), Some("/key+"));
}

#[test]
fn unknown_malformed_and_oversized_sources_have_no_key() {
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
        assert!(key_from_url(&url).is_none(), "{url}");
    }
    let maximum = format!("https://{native}/{}", "%41".repeat(1024));
    assert_eq!(key_from_url(&maximum).unwrap().len(), 1024);
    let large_query = format!("{maximum}?signature={}", "s".repeat(100_000));
    assert_eq!(key_from_url(&large_query), key_from_url(&maximum));
}
