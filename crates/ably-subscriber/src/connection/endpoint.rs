use crate::Error;

pub(crate) const DEFAULT_REALTIME_HOST: &str = "realtime.ably.io";
pub(super) const PROTOCOL_VERSION: &str = "5";
const AGENT_STRING: &str = concat!("ably-subscriber-rs/", env!("CARGO_PKG_VERSION"));

fn is_localhost_url(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost") => true,
        Some(url::Host::Ipv4(addr)) if addr == std::net::Ipv4Addr::LOCALHOST => true,
        Some(url::Host::Ipv6(addr)) if addr == std::net::Ipv6Addr::LOCALHOST => true,
        _ => false,
    }
}

fn contains_url_ignored_ascii_whitespace(value: &str) -> bool {
    value.bytes().any(|b| matches!(b, b'\t' | b'\n' | b'\r'))
}

fn contains_endpoint_path_separator(value: &str) -> bool {
    value.bytes().any(|b| matches!(b, b'/' | b'\\'))
}

fn invalid_url_component() -> Error {
    Error::Url(url::ParseError::InvalidDomainCharacter)
}

fn parse_endpoint_host(host: &str, scheme: &str) -> Result<url::Url, Error> {
    if contains_url_ignored_ascii_whitespace(host) || contains_endpoint_path_separator(host) {
        return Err(invalid_url_component());
    }

    let url = url::Url::parse(&format!("{scheme}://{host}/"))?;

    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_url_component());
    }

    Ok(url)
}

fn build_endpoint_base_url(
    host: &str,
    localhost_scheme: &str,
    remote_scheme: &str,
) -> Result<url::Url, Error> {
    let host_url = parse_endpoint_host(host, "http")?;
    let scheme = if is_localhost_url(&host_url) {
        localhost_scheme
    } else {
        remote_scheme
    };
    parse_endpoint_host(host, scheme)
}

/// Derive REST host from realtime host.
pub(crate) fn rest_host(realtime_host: &str) -> String {
    if realtime_host == DEFAULT_REALTIME_HOST {
        "rest.ably.io".to_string()
    } else {
        realtime_host.to_string()
    }
}

pub(super) fn build_ws_url(
    host: &str,
    token: &str,
    resume: Option<&str>,
    heartbeat_interval: Option<std::time::Duration>,
) -> Result<String, Error> {
    let mut u = build_endpoint_base_url(host, "ws", "wss")?;
    {
        let mut q = u.query_pairs_mut();
        q.append_pair("access_token", token);
        q.append_pair("format", "msgpack");
        q.append_pair("v", PROTOCOL_VERSION);
        q.append_pair("agent", AGENT_STRING);
        // Native WebSockets answer control Ping automatically, as in ably-js.
        q.append_pair("heartbeats", "false");
        q.append_pair("echo", "false");
        if let Some(interval) = heartbeat_interval {
            q.append_pair("heartbeatInterval", &interval.as_millis().to_string());
        }
        if let Some(key) = resume {
            q.append_pair("resume", key);
        }
    }
    Ok(u.to_string())
}

pub(super) fn build_token_request_url(host: &str, key_name: &str) -> Result<url::Url, Error> {
    if matches!(key_name, "." | "..") || contains_url_ignored_ascii_whitespace(key_name) {
        return Err(invalid_url_component());
    }

    let mut url = build_endpoint_base_url(host, "http", "https")?;
    url.path_segments_mut()
        .map_err(|_| invalid_url_component())?
        .push("keys")
        .push(key_name)
        .push("requestToken");
    Ok(url)
}

#[cfg(test)]
mod tests;
