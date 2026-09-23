use std::io::{self, IoSlice, Write};
use std::path::Path;

pub(super) fn append_lines(path: &Path, lines: &[String]) -> io::Result<()> {
    let mut file = runner_host::log_file::open_append(path, false)?;

    match lines {
        [] => Ok(()),
        [line] => file.write_all(line.as_bytes()),
        _ => write_lines_vectored(&mut file, lines),
    }
}

fn write_lines_vectored(writer: &mut impl Write, lines: &[String]) -> io::Result<()> {
    let mut bufs: Vec<IoSlice<'_>> = lines
        .iter()
        .map(String::as_bytes)
        .filter(|bytes| !bytes.is_empty())
        .map(IoSlice::new)
        .collect();
    let mut bufs = &mut bufs[..];

    while !bufs.is_empty() {
        let written = match writer.write_vectored(bufs) {
            Ok(written) => written,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if written == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "failed to write network log batch",
            ));
        }

        IoSlice::advance_slices(&mut bufs, written);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{self, IoSlice, Write};

    use super::*;

    #[derive(Default)]
    struct FragmentedWriter {
        bytes: Vec<u8>,
        max_chunk: usize,
        interrupt_once: bool,
        zero_once: bool,
    }

    impl Write for FragmentedWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.write_vectored(&[IoSlice::new(buf)])
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn write_vectored(&mut self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
            if self.interrupt_once {
                self.interrupt_once = false;
                return Err(io::Error::from(io::ErrorKind::Interrupted));
            }
            if self.zero_once {
                self.zero_once = false;
                return Ok(0);
            }

            let mut remaining = self.max_chunk;
            let mut written = 0;
            for buf in bufs {
                if remaining == 0 {
                    break;
                }
                let chunk_len = buf.len().min(remaining);
                self.bytes.extend_from_slice(&buf[..chunk_len]);
                written += chunk_len;
                remaining -= chunk_len;
                if chunk_len < buf.len() {
                    break;
                }
            }
            Ok(written)
        }
    }

    #[test]
    fn write_lines_vectored_completes_partial_and_interrupted_writes() {
        let lines = vec![
            "first\n".to_string(),
            "second\n".to_string(),
            "third\n".to_string(),
        ];
        let mut writer = FragmentedWriter {
            max_chunk: 3,
            interrupt_once: true,
            ..Default::default()
        };

        write_lines_vectored(&mut writer, &lines).unwrap();

        assert_eq!(writer.bytes, b"first\nsecond\nthird\n");
    }

    #[test]
    fn write_lines_vectored_returns_write_zero() {
        let lines = vec!["first\n".to_string(), "second\n".to_string()];
        let mut writer = FragmentedWriter {
            max_chunk: 3,
            zero_once: true,
            ..Default::default()
        };

        let error = write_lines_vectored(&mut writer, &lines).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::WriteZero);
        assert!(writer.bytes.is_empty());
    }

    #[test]
    fn write_lines_vectored_accepts_empty_lines() {
        let lines = vec!["".to_string(), "".to_string()];
        let mut writer = FragmentedWriter {
            max_chunk: 3,
            zero_once: true,
            ..Default::default()
        };

        write_lines_vectored(&mut writer, &lines).unwrap();

        assert!(writer.bytes.is_empty());
        assert!(writer.zero_once);
    }
}
