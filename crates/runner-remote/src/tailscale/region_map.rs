//! Validate bounded trusted-map relay inputs before permissive SDK conversion.

use std::collections::HashSet;

use ts_control_serde::DerpMap;

pub(super) fn valid(map: &DerpMap<'_>) -> bool {
    if map.regions.len() > 128
        || map
            .home_params
            .as_ref()
            .is_some_and(|home| home.region_score.len() > 128)
    {
        return false;
    }
    let mut names = HashSet::new();
    map.regions.iter().all(|(id, region)| {
        *id == region.id
            && region.name.len() <= 128
            && region.code.len() <= 32
            && !region.name.chars().any(char::is_control)
            && !region.code.chars().any(char::is_control)
            && region.nodes.len() <= 8
            && region.nodes.iter().all(|server| {
                server.region_id == *id
                    && !server.name.is_empty()
                    && server.name.len() <= 64
                    && server.name.is_ascii()
                    && names.insert(server.name)
                    && hostname(server.hostname)
                    && !server.insecure_for_tests
                    && server.stun_test_ip.is_none()
                    && server
                        .cert_name
                        .is_none_or(|name| name.is_empty() || hostname(name))
            })
    })
}

pub(super) fn hostname(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.is_ascii()
        && (name.parse::<std::net::IpAddr>().is_ok()
            || name.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            }))
}
