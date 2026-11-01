//! Decode a bounded zstd request before the identity-constrained file writer.
use std::io::{self, BufRead, Read, Write};

struct Exact<R> {
    inner: R,
    remaining: usize,
}

struct EncodedChecksum<R> {
    inner: R,
    verification: Option<(crc32fast::Hasher, u32)>,
}

impl<R: Read> Read for EncodedChecksum<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        let read = self.inner.read(out)?;
        if read == 0 {
            if let Some((hasher, expected)) = self.verification.take()
                && hasher.finalize() != expected
            {
                return Err(io::Error::other("encoded source CRC mismatch"));
            }
        } else if let Some((hasher, _)) = &mut self.verification {
            hasher.update(
                out.get(..read)
                    .ok_or_else(|| io::Error::other("invalid encoded chunk"))?,
            );
        }
        Ok(read)
    }
}
impl<R: Read> Read for Exact<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut extra = [0; 1];
            if self.inner.read(&mut extra)? != 0 {
                return Err(io::Error::other("decoded output exceeds declared size"));
            }
            return Ok(0);
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
    let (size, args, crc32) = match parse_args(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}\n{}", super::USAGE);
            return 2;
        }
    };
    match decode(size, args, input, crc32) {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "guest-write-file: {error}");
            1
        }
    }
}

fn parse_args(args: Vec<String>) -> Result<(usize, super::Args, Option<u32>), String> {
    let source = args.first().is_some_and(|arg| arg == "--zstd-source");
    let mut args = args.into_iter().skip(1);
    let size: usize = args
        .next()
        .ok_or("missing decoded size")?
        .parse()
        .map_err(|error: std::num::ParseIntError| error.to_string())?;
    let limit = if source {
        guest_control_proto::MAX_ZSTD_SOURCE_BYTES
    } else {
        15 * 1024 * 1024
    };
    if size > limit {
        return Err("declared raw size too large".into());
    }
    let crc32 = if source {
        Some(
            args.next()
                .ok_or("missing encoded CRC")?
                .parse::<u32>()
                .map_err(|_| "invalid encoded CRC")?,
        )
    } else {
        None
    };
    let args = super::parse_args(args)?;
    if args.private || args.batch || (source && args.append) {
        return Err("unsupported streaming mode".into());
    }
    Ok((size, args, crc32))
}

fn decode(size: usize, args: super::Args, input: impl Read, crc32: Option<u32>) -> io::Result<()> {
    let source = crc32.is_some();
    let mut input = EncodedChecksum {
        inner: input,
        verification: crc32.map(|crc| (crc32fast::Hasher::new(), crc)),
    };
    // Reject skippable frames. Transport frames promise a checksum; source
    // frames carry CRC over source bytes authenticated on the Host.
    let mut prefix = [0; 5];
    input.read_exact(&mut prefix)?;
    let [a, b, c, d, flags] = prefix;
    if [a, b, c, d] != [0x28, 0xb5, 0x2f, 0xfd] || (!source && flags & 0x04 == 0) {
        return Err(io::Error::other("expected checksummed zstd frame"));
    }
    let mut input = io::BufReader::with_capacity(64 * 1024, io::Cursor::new(prefix).chain(input));
    let mut decoder = zstd::stream::read::Decoder::with_buffer(&mut input)?.single_frame();
    decoder.window_log_max(if source { 27 } else { 24 })?;
    let output = Exact {
        inner: &mut decoder,
        remaining: size,
    };
    if source {
        super::run(args, io::BufReader::with_capacity(64 * 1024, output))?;
    } else {
        super::run(args, output)?;
    }
    drop(decoder);
    if !input.fill_buf()?.is_empty() {
        return Err(io::Error::other("trailing encoded bytes"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;
