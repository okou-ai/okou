//! Decode a bounded zstd request before the identity-constrained file writer.
use std::io::{self, BufRead, Read, Write};

struct Exact<R> {
    inner: R,
    remaining: usize,
}
impl<R: Read> Read for Exact<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0; 1];
            return if self.inner.read(&mut extra)? == 0 {
                Ok(0)
            } else {
                Err(io::Error::other("decoded output exceeds declared size"))
            };
        }
        let cap = out.len().min(self.remaining);
        let buffer = out
            .get_mut(..cap)
            .ok_or_else(|| io::Error::other("invalid output bound"))?;
        let n = self.inner.read(buffer)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "short decoded stream",
            ));
        }
        self.remaining -= n;
        Ok(n)
    }
}

pub(super) fn run(args: Vec<String>, input: impl Read, mut stderr: impl Write) -> i32 {
    let (size, args) = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}\n{}", super::USAGE);
            return 2;
        }
    };
    match decode(size, args, input) {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}");
            1
        }
    }
}

fn parse_args(args: Vec<String>) -> Result<(usize, super::Args), String> {
    let mut args = args.into_iter().skip(1);
    let size: usize = args
        .next()
        .ok_or("missing decoded size")?
        .parse()
        .map_err(|error: std::num::ParseIntError| error.to_string())?;
    if size > 15 * 1024 * 1024 {
        return Err("declared raw size too large".into());
    }
    let args = super::parse_args(args)?;
    if args.private || args.batch {
        return Err("unsupported streaming mode".into());
    }
    Ok((size, args))
}

fn decode(size: usize, args: super::Args, mut input: impl Read) -> io::Result<()> {
    // Reject skippable frames and require the checksum promised by this protocol.
    let mut prefix = [0; 5];
    input.read_exact(&mut prefix)?;
    let [a, b, c, d, flags] = prefix;
    if [a, b, c, d] != [0x28, 0xb5, 0x2f, 0xfd] || flags & 0x04 == 0 {
        return Err(io::Error::other("expected checksummed zstd frame"));
    }
    let mut input = io::BufReader::with_capacity(64 * 1024, io::Cursor::new(prefix).chain(input));
    let mut decoder = zstd::stream::read::Decoder::with_buffer(&mut input)?.single_frame();
    decoder.window_log_max(24)?;
    super::run(
        args,
        Exact {
            inner: &mut decoder,
            remaining: size,
        },
    )?;
    drop(decoder);
    if !input.fill_buf()?.is_empty() {
        return Err(io::Error::other("trailing encoded bytes"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn encoded(raw: &[u8]) -> Vec<u8> {
        let mut writer = zstd::stream::write::Encoder::new(Vec::new(), -1).unwrap();
        writer.include_checksum(true).unwrap();
        writer.set_pledged_src_size(Some(raw.len() as u64)).unwrap();
        writer.write_all(raw).unwrap();
        writer.finish().unwrap()
    }

    fn invoke(path: &std::path::Path, size: usize, bytes: &[u8]) -> (i32, String) {
        let mut stderr = Vec::new();
        let code = super::super::run_cli(
            [
                "--zstd".into(),
                size.to_string(),
                "--".into(),
                path.to_str().unwrap().into(),
            ],
            bytes,
            &mut stderr,
        );
        (code, String::from_utf8(stderr).unwrap())
    }

    #[test]
    fn invalid_compressed_arguments_report_usage_errors() {
        for args in [
            vec!["--zstd"],
            vec!["--zstd", "invalid", "--", "/unused"],
            vec!["--zstd", "0", "--private", "--", "/unused"],
            vec!["--zstd", "0", "--batch"],
        ] {
            let mut stderr = Vec::new();
            assert_eq!(
                super::super::run_cli(
                    args.into_iter().map(str::to_string),
                    b"".as_slice(),
                    &mut stderr
                ),
                2
            );
            assert!(String::from_utf8(stderr).unwrap().contains("usage:"));
        }
    }

    #[test]
    fn exact_size_zstd_preserves_bytes() {
        let dir = tempfile::tempdir().unwrap();
        for raw in [b"".as_slice(), b"test-stream\0"] {
            let payload = encoded(raw);
            let path = dir.path().join("out");
            assert_eq!(invoke(&path, raw.len(), &payload), (0, String::new()));
            assert_eq!(fs::read(path).unwrap(), raw);
        }
    }

    #[test]
    fn short_and_oversized_decoded_streams_fail() {
        let dir = tempfile::tempdir().unwrap();
        let payload = encoded(b"hello");
        for size in [4, 6] {
            assert_ne!(invoke(&dir.path().join("out"), size, &payload).0, 0);
        }
    }

    #[test]
    fn truncated_checksum_and_trailing_frames_fail() {
        let dir = tempfile::tempdir().unwrap();
        let encoded = encoded(b"hello");
        let mut corrupt = encoded.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        let mut trailing = encoded.clone();
        trailing.extend_from_slice(b"extra");
        let mut concatenated = encoded.clone();
        concatenated.extend_from_slice(&encoded);
        for bytes in [
            encoded[..encoded.len() - 1].to_vec(),
            corrupt,
            trailing,
            concatenated,
        ] {
            assert_ne!(invoke(&dir.path().join("out"), 5, &bytes).0, 0);
        }
    }

    #[test]
    fn checksumless_and_oversized_window_frames_fail() {
        let dir = tempfile::tempdir().unwrap();
        let unchecked = zstd::stream::encode_all(b"hello".as_slice(), -1).unwrap();
        assert_eq!(
            zstd::stream::decode_all(unchecked.as_slice()).unwrap(),
            b"hello"
        );
        assert_ne!(invoke(&dir.path().join("unchecked"), 5, &unchecked).0, 0);

        // A valid empty frame with a 32 MiB window exceeds our 16 MiB limit.
        let empty = encoded(b"");
        let mut oversized = vec![0x28, 0xb5, 0x2f, 0xfd, 0x04, 120, 1, 0, 0];
        oversized.extend_from_slice(&empty[empty.len() - 4..]);
        assert!(
            zstd::stream::decode_all(oversized.as_slice())
                .unwrap()
                .is_empty()
        );
        assert_ne!(invoke(&dir.path().join("oversized"), 0, &oversized).0, 0);
    }

    #[test]
    fn stream_keeps_destination_symlink_protection() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        let target = dir.path().join("target");
        fs::write(&original, b"unchanged").unwrap();
        std::os::unix::fs::symlink(&original, &target).unwrap();
        let payload = encoded(b"hello");
        assert_ne!(invoke(&target, 5, &payload).0, 0);
        assert_eq!(fs::read(&original).unwrap(), b"unchanged");
    }

    #[test]
    fn declared_size_bound_fails_before_opening_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("absent");
        assert_ne!(invoke(&target, 15 * 1024 * 1024 + 1, b"").0, 0);
        assert!(!target.exists());
    }
}
