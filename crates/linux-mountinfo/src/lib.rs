//! Byte-preserving parsing of Linux `/proc/<pid>/mountinfo`.
//!
//! Callers own filesystem reads, path normalization, and the policy for invalid
//! records or empty tables. Only mount identity, device, root and target fields
//! are interpreted; no mount or privilege decisions are made here.

use std::io;

/// The mountinfo fields needed to identify a mount and its target.
#[derive(Debug, PartialEq, Eq)]
pub struct Mount {
    /// Kernel mount ID, including the identity used by `statx`.
    pub id: u64,
    /// Filesystem device major and minor numbers.
    pub device: (u32, u32),
    /// Decoded filesystem root exposed by this mount, including bind subtrees.
    pub root: Vec<u8>,
    /// Decoded mountpoint bytes, without UTF-8 conversion or normalization.
    pub target: Vec<u8>,
}

/// Parse nonempty LF-delimited mountinfo records independently.
///
/// Fields are separated by ASCII spaces, so Unicode whitespace and non-UTF-8
/// path bytes remain data. Root and target paths decode the kernel's `\040`,
/// `\011`, `\012`, and `\134` escapes exactly once. Invalid record shapes,
/// mount/device numbers and path escapes produce [`io::ErrorKind::InvalidData`]. Other
/// fields, including optional fields, are not interpreted.
///
/// Empty input yields no records. Consumers can collect into a `Result` to
/// reject any invalid record, or handle each record's error separately.
pub fn parse(input: &[u8]) -> impl Iterator<Item = io::Result<Mount>> + '_ {
    input
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(parse_line)
}

fn parse_line(line: &[u8]) -> io::Result<Mount> {
    let fields: Vec<_> = line.split(|byte| *byte == b' ').collect();
    let Some(separator) = fields.iter().position(|field| *field == b"-") else {
        return Err(invalid("invalid mountinfo record"));
    };
    if separator < 6 || fields.len() != separator + 4 {
        return Err(invalid("invalid mountinfo fields"));
    }
    let [id, _, device, root, target, ..] = fields.as_slice() else {
        return Err(invalid("invalid mountinfo fields"));
    };
    let id = parse_number(id)?;
    let mut device = device.split(|byte| *byte == b':');
    let major = parse_number(device.next().unwrap_or_default())?;
    let minor = parse_number(device.next().unwrap_or_default())?;
    if device.next().is_some() {
        return Err(invalid("invalid mountinfo device"));
    }
    Ok(Mount {
        id,
        device: (major, minor),
        root: decode_path(root)?,
        target: decode_path(target)?,
    })
}

fn parse_number<T: std::str::FromStr>(input: &[u8]) -> io::Result<T> {
    std::str::from_utf8(input)
        .ok()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| invalid("invalid mountinfo number"))
}

fn decode_path(input: &[u8]) -> io::Result<Vec<u8>> {
    if input.is_empty() {
        return Err(invalid("empty mountinfo path"));
    }
    let mut path = Vec::with_capacity(input.len());
    let mut index = 0;
    while let Some(&byte) = input.get(index) {
        if byte != b'\\' {
            path.push(byte);
            index += 1;
            continue;
        }
        let decoded = match input.get(index..index + 4) {
            Some(b"\\040") => b' ',
            Some(b"\\011") => b'\t',
            Some(b"\\012") => b'\n',
            Some(b"\\134") => b'\\',
            _ => return Err(invalid("invalid mountinfo path escape")),
        };
        path.push(decoded);
        index += 4;
    }
    Ok(path)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
