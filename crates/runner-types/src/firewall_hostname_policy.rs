//! Raw hostname checks for the shared credential endpoint identity contract.
//!
//! URL parsers intentionally canonicalize legacy IPv4 and IDNA spellings. The
//! shared firewall contract pins the behavior that rejects spellings hiding
//! authority identity, so these checks run while callers still own the original
//! representation.

use unicode_normalization::UnicodeNormalization;

const IDNA_DOT_EQUIVALENTS: [char; 3] = ['\u{3002}', '\u{ff0e}', '\u{ff61}'];
const IPV4_OCTET_COUNT: usize = 4;
const IPV4_MAX_OCTET: u16 = 255;

const UNSAFE_UTS46_COLLISION_CHARS: [char; 15] = [
    '\u{03f2}',
    '\u{04c0}',
    '\u{1e9e}',
    '\u{1806}',
    '\u{2132}',
    '\u{2183}',
    '\u{3164}',
    '\u{ffa0}',
    '\u{fffc}',
    '\u{fffd}',
    '\u{2f868}',
    '\u{2f874}',
    '\u{2f91f}',
    '\u{2f95f}',
    '\u{2f9bf}',
];
const UNSAFE_UTS46_COLLISION_RANGES: [(u32, u32); 4] = [
    (0x10a0, 0x10c5),
    (0x115f, 0x1160),
    (0x17b4, 0x17b5),
    (0x2ff0, 0x2ffb),
];
const UNSAFE_UTS46_IGNORABLE_RANGES: [(u32, u32); 4] = [
    (0x034f, 0x034f),
    (0x180b, 0x180d),
    (0x180f, 0x180f),
    (0xfe00, 0xfe0f),
];
const UNSAFE_UTS46_SUPPLEMENTARY_IGNORABLE_RANGE: (u32, u32) = (0xe0100, 0xe01ef);

// Unicode 17 assignments from DerivedAge.txt. The shared hostname policy is
// pinned to Unicode 16, so both direct Unicode and A-label forms must reject
// characters introduced after that policy boundary.
// https://www.unicode.org/Public/17.0.0/ucd/DerivedAge.txt
const UNICODE_17_ASSIGNMENT_RANGES: [(u32, u32); 47] = [
    (0x088f, 0x088f),
    (0x0c5c, 0x0c5c),
    (0x0cdc, 0x0cdc),
    (0x1acf, 0x1add),
    (0x1ae0, 0x1aeb),
    (0x20c1, 0x20c1),
    (0x2b96, 0x2b96),
    (0xa7ce, 0xa7cf),
    (0xa7d2, 0xa7d2),
    (0xa7d4, 0xa7d4),
    (0xa7f1, 0xa7f1),
    (0xfbc3, 0xfbd2),
    (0xfd90, 0xfd91),
    (0xfdc8, 0xfdce),
    (0x10940, 0x10959),
    (0x10ec5, 0x10ec7),
    (0x10ed0, 0x10ed8),
    (0x10efa, 0x10efb),
    (0x11b60, 0x11b67),
    (0x11db0, 0x11ddb),
    (0x11de0, 0x11de9),
    (0x16ea0, 0x16eb8),
    (0x16ebb, 0x16ed3),
    (0x16ff2, 0x16ff6),
    (0x187f8, 0x187ff),
    (0x18d09, 0x18d1e),
    (0x18d80, 0x18df2),
    (0x1ccfa, 0x1ccfc),
    (0x1ceba, 0x1ced0),
    (0x1cee0, 0x1cef0),
    (0x1e6c0, 0x1e6de),
    (0x1e6e0, 0x1e6f5),
    (0x1e6fe, 0x1e6ff),
    (0x1f6d8, 0x1f6d8),
    (0x1f777, 0x1f77a),
    (0x1f8d0, 0x1f8d8),
    (0x1fa54, 0x1fa57),
    (0x1fa8a, 0x1fa8a),
    (0x1fa8e, 0x1fa8e),
    (0x1fac8, 0x1fac8),
    (0x1facd, 0x1facd),
    (0x1faea, 0x1faea),
    (0x1faef, 0x1faef),
    (0x1fbfa, 0x1fbfa),
    (0x2b73a, 0x2b73f),
    (0x2cea2, 0x2cead),
    (0x323b0, 0x33479),
];

pub fn raw_url_authority(value: &str) -> Option<&str> {
    let rest = value.split_once("://").map(|(_, rest)| rest)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(&rest[..authority_end])
}

pub fn raw_host_from_authority(authority: &str) -> &str {
    let without_userinfo = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    if without_userinfo.starts_with('[') {
        return without_userinfo
            .find(']')
            .map_or(without_userinfo, |end| &without_userinfo[..=end]);
    }
    without_userinfo
        .rsplit_once(':')
        .map_or(without_userinfo, |(host, _)| host)
}

pub fn validate_raw_url_host(raw_host: &str, subject: &str) -> Result<(), String> {
    if raw_host.starts_with('[') && raw_host.ends_with(']') {
        return Ok(());
    }
    if raw_host.is_empty() {
        return Err(format!("{subject} must include a host"));
    }

    validate_percent_encoding(raw_host, subject)?;
    let decoded_host = percent_decode(raw_host)
        .ok_or_else(|| format!("{subject} host has invalid percent encoding"))?;
    let normalized_host = translate_idna_dots(&decoded_host);
    let host = normalized_host
        .strip_suffix('.')
        .unwrap_or(&normalized_host);
    if host.is_empty() || host.ends_with('.') || host.split('.').any(str::is_empty) {
        return Err(format!("{subject} host labels must be non-empty"));
    }
    if host
        .chars()
        .any(|ch| matches!(ch, '*' | ',' | '<' | '>' | '[' | ']' | '^' | '|'))
    {
        return Err(format!("{subject} host contains forbidden syntax"));
    }

    validate_canonical_ipv4(&decoded_host, host, subject)?;
    for label in host.split('.') {
        validate_hostname_policy_label(label, subject)?;
    }
    Ok(())
}

pub fn is_ipv4_literal_like(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    !labels.is_empty()
        && labels.len() <= IPV4_OCTET_COUNT
        && labels.iter().all(|label| {
            let Some(rest) = label
                .strip_prefix("0x")
                .or_else(|| label.strip_prefix("0X"))
            else {
                return !label.is_empty() && label.chars().all(|ch| ch.is_ascii_digit());
            };
            !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_hexdigit())
        })
}

fn validate_canonical_ipv4(
    raw_host: &str,
    normalized_host: &str,
    subject: &str,
) -> Result<(), String> {
    let raw_host = raw_host.strip_suffix('.').unwrap_or(raw_host);
    if is_ipv4_literal_like(normalized_host)
        && (raw_host != normalized_host || !is_canonical_ipv4(normalized_host))
    {
        return Err(format!(
            "{subject} host must use canonical IPv4 address syntax"
        ));
    }
    Ok(())
}

fn is_canonical_ipv4(host: &str) -> bool {
    let octets: Vec<&str> = host.split('.').collect();
    octets.len() == IPV4_OCTET_COUNT
        && octets.iter().all(|octet| {
            !octet.is_empty()
                && octet.chars().all(|ch| ch.is_ascii_digit())
                && (octet.len() == 1 || !octet.starts_with('0'))
                && octet
                    .parse::<u16>()
                    .is_ok_and(|value| value <= IPV4_MAX_OCTET)
        })
}

fn validate_percent_encoding(host: &str, subject: &str) -> Result<(), String> {
    let bytes = host.as_bytes();
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte != b'%' {
            index += 1;
            continue;
        }

        let start = index;
        while bytes.get(index) == Some(&b'%') {
            if bytes
                .get(index + 1)
                .and_then(|byte| hex_value(*byte))
                .is_none()
                || bytes
                    .get(index + 2)
                    .and_then(|byte| hex_value(*byte))
                    .is_none()
            {
                return Err(format!("{subject} host has invalid percent encoding"));
            }
            index += 3;
        }
        let decoded = percent_decode(&host[start..index])
            .ok_or_else(|| format!("{subject} host has invalid percent encoding"))?;
        if decoded.chars().any(|ch| {
            ch <= '\u{20}'
                || ch == '\u{7f}'
                || matches!(
                    ch,
                    '/' | ':' | '?' | '#' | '@' | '\\' | '{' | '}' | ',' | '*'
                )
                || ch == '.'
                || IDNA_DOT_EQUIVALENTS.contains(&ch)
        }) {
            return Err(format!("{subject} host contains encoded authority syntax"));
        }
    }
    Ok(())
}

fn validate_hostname_policy_label(label: &str, subject: &str) -> Result<(), String> {
    if label.chars().any(has_unsafe_uts46_mapping) {
        return Err(format!(
            "{subject} host contains unsafe IDNA compatibility mappings"
        ));
    }
    if label.chars().any(is_post_policy_assignment) || alabel_uses_post_policy_assignment(label) {
        return Err(format!(
            "{subject} host exceeds the supported Unicode policy"
        ));
    }
    if !label.is_ascii() {
        let normalized: String = label
            .nfkd()
            .collect::<String>()
            .nfc()
            .flat_map(char::to_lowercase)
            .collect();
        if normalized.is_ascii() {
            return Err(format!(
                "{subject} host contains unsafe IDNA compatibility mappings"
            ));
        }
    }
    Ok(())
}

fn alabel_uses_post_policy_assignment(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    let Some(payload) = lower.strip_prefix("xn--") else {
        return false;
    };
    idna::punycode::decode_to_string(payload)
        .is_some_and(|decoded| decoded.chars().any(is_post_policy_assignment))
}

fn has_unsafe_uts46_mapping(ch: char) -> bool {
    let codepoint = u32::from(ch);
    UNSAFE_UTS46_COLLISION_CHARS.contains(&ch)
        || codepoint_in_ranges(codepoint, &UNSAFE_UTS46_COLLISION_RANGES)
        || codepoint_in_ranges(codepoint, &UNSAFE_UTS46_IGNORABLE_RANGES)
        || codepoint_in_range(codepoint, UNSAFE_UTS46_SUPPLEMENTARY_IGNORABLE_RANGE)
}

fn is_post_policy_assignment(ch: char) -> bool {
    codepoint_in_ranges(u32::from(ch), &UNICODE_17_ASSIGNMENT_RANGES)
}

fn codepoint_in_ranges(codepoint: u32, ranges: &[(u32, u32)]) -> bool {
    ranges
        .iter()
        .any(|range| codepoint_in_range(codepoint, *range))
}

fn codepoint_in_range(codepoint: u32, (start, end): (u32, u32)) -> bool {
    start <= codepoint && codepoint <= end
}

fn translate_idna_dots(host: &str) -> String {
    host.chars()
        .map(|ch| {
            if IDNA_DOT_EQUIVALENTS.contains(&ch) {
                '.'
            } else {
                ch
            }
        })
        .collect()
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        if byte != b'%' {
            decoded.push(byte);
            index += 1;
            continue;
        }
        let high = hex_value(*bytes.get(index + 1)?)?;
        let low = hex_value(*bytes.get(index + 2)?)?;
        decoded.push((high << 4) | low);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub fn is_public_ip_address(address: std::net::IpAddr) -> bool {
    use api_contracts::generated::public_destination_policy::*;
    use std::net::IpAddr;
    match address {
        IpAddr::V4(ip) => !IPV4_NON_PUBLIC_RANGES
            .iter()
            .any(|&(start, end)| (start..=end).contains(&u32::from(ip))),
        IpAddr::V6(ip) => {
            let words = ip.segments();
            let first = words[0];
            let second = words[1];
            if !(IPV6_GLOBAL_UNICAST_FIRST_MIN..=IPV6_GLOBAL_UNICAST_FIRST_MAX).contains(&first) {
                return false;
            }
            if first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST
                && second <= IPV6_IETF_PROTOCOL_ASSIGNMENTS_SECOND_MAX
            {
                return (second == IPV6_SPECIAL_EXACT_SECOND
                    && words[2..7].iter().all(|&word| word == 0)
                    && (IPV6_SPECIAL_EXACT_LAST_MIN..=IPV6_SPECIAL_EXACT_LAST_MAX)
                        .contains(&words[7]))
                    || second == IPV6_AMT_SECOND
                    || (second == IPV6_AS112_SECOND && words[2] == IPV6_AS112_THIRD)
                    || (IPV6_ORCHID_SECOND_MIN..=IPV6_ORCHID_SECOND_MAX).contains(&second)
                    || (IPV6_DRONE_REMOTE_ID_SECOND_MIN..=IPV6_DRONE_REMOTE_ID_SECOND_MAX)
                        .contains(&second);
            }
            !(first == IPV6_IETF_PROTOCOL_ASSIGNMENTS_FIRST && second == IPV6_DOCUMENTATION_SECOND
                || first == IPV6_EXPANDED_DOCUMENTATION_FIRST
                    && second <= IPV6_EXPANDED_DOCUMENTATION_SECOND_MAX
                || first == IPV6_SIX_TO_FOUR_FIRST)
        }
    }
}
