use std::io::{self, IoSlice, Write};
use std::path::Path;

pub(super) fn append_lines<'a>(
    path: &Path,
    mut lines: impl Iterator<Item = &'a str>,
) -> io::Result<()> {
    let mut file = runner_host::log_file::open_append(path, false)?;

    let Some(first) = lines.next() else {
        return Ok(());
    };
    let Some(second) = lines.next() else {
        return file.write_all(first.as_bytes());
    };
    write_lines_vectored(&mut file, [first, second].into_iter().chain(lines))
}

fn write_lines_vectored<'a>(
    writer: &mut impl Write,
    lines: impl Iterator<Item = &'a str>,
) -> io::Result<()> {
    let mut bufs: Vec<IoSlice<'_>> = lines
        .map(str::as_bytes)
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
mod tests;
