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
    let lines = ["first\n", "second\n", "third\n"];
    let mut writer = FragmentedWriter {
        max_chunk: 3,
        interrupt_once: true,
        ..Default::default()
    };

    write_lines_vectored(&mut writer, lines.into_iter()).unwrap();

    assert_eq!(writer.bytes, b"first\nsecond\nthird\n");
}

#[test]
fn write_lines_vectored_returns_write_zero() {
    let lines = ["first\n", "second\n"];
    let mut writer = FragmentedWriter {
        max_chunk: 3,
        zero_once: true,
        ..Default::default()
    };

    let error = write_lines_vectored(&mut writer, lines.into_iter()).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::WriteZero);
    assert!(writer.bytes.is_empty());
}

#[test]
fn write_lines_vectored_accepts_empty_lines() {
    let lines = ["", ""];
    let mut writer = FragmentedWriter {
        max_chunk: 3,
        zero_once: true,
        ..Default::default()
    };

    write_lines_vectored(&mut writer, lines.into_iter()).unwrap();

    assert!(writer.bytes.is_empty());
    assert!(writer.zero_once);
}
