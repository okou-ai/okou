use std::cell::Cell;
use std::io::{self, Read};

/// Encoded metadata retained for one member, including headers and padding.
/// This also bounds any individual extension and GNU sparse map. Allocator
/// capacity and parsed sparse descriptors add bounded overhead to these bytes.
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
pub(crate) struct MetadataBudget {
    remaining: Cell<u64>,
    payload: Cell<u64>,
}

impl MetadataBudget {
    pub(crate) fn begin_entry(&self) {
        self.remaining.set(MAX_METADATA_BYTES);
    }

    /// Exempt only the yielded member's physical data and padding. The tar
    /// iterator itself skips unread data, including sparse data without reading
    /// logical holes. Keep this allowance across the next metadata-budget reset.
    pub(crate) fn allow_payload<R: Read>(&self, entry: &mut tar::Entry<'_, R>) -> io::Result<()> {
        let kind = entry.header().entry_type();
        let size = if kind.is_gnu_sparse() {
            // tar replaces Entry::size() with the logical sparse size. Its raw
            // payload size still honors PAX: the first size value before a
            // malformed record wins, with an invalid value ignored. Match the
            // locked parser's precedence using its retained PAX records.
            let pax_size = entry.pax_extensions()?.and_then(|extensions| {
                extensions
                    .map_while(Result::ok)
                    .find(|extension| extension.key_bytes() == b"size")
                    .and_then(|extension| extension.value().ok()?.parse::<u64>().ok())
            });
            pax_size.unwrap_or(entry.header().entry_size()?)
        } else {
            entry.size()
        };

        let padded_size = size.checked_add(511).ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidData, "tar payload size overflow")
        })? & !511;

        // Global PAX and unrecognized-format extension members can be yielded
        // without buffering. Include their bodies/padding in this member's
        // metadata limit before allowing the iterator to skip them.
        if (kind.is_pax_global_extensions()
            || kind.is_pax_local_extensions()
            || kind.is_gnu_longname()
            || kind.is_gnu_longlink())
            && padded_size > self.remaining.get()
        {
            return Err(metadata_limit_error());
        }

        self.payload.set(padded_size);
        Ok(())
    }
}

pub(crate) struct MetadataReader<'a, R> {
    reader: R,
    budget: &'a MetadataBudget,
}

impl<'a, R: Read> MetadataReader<'a, R> {
    pub(crate) fn new(reader: R, budget: &'a MetadataBudget) -> Self {
        Self { reader, budget }
    }
}

impl<R: Read> Read for MetadataReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let allowance = if self.budget.payload.get() != 0 {
            &self.budget.payload
        } else {
            &self.budget.remaining
        };
        let remaining = allowance.get();
        if remaining == 0 {
            return Err(metadata_limit_error());
        }
        let limit = buffer
            .len()
            .min(usize::try_from(remaining).unwrap_or(usize::MAX));
        let (buffer, _) = buffer.split_at_mut(limit);
        let read = self.reader.read(buffer)?;
        allowance.set(remaining - read as u64);
        Ok(read)
    }
}

fn metadata_limit_error() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "tar extension metadata exceeds the 1 MiB per-member budget",
    )
}

#[cfg(test)]
mod tests;
