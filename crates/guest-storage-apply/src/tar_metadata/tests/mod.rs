use super::*;
use std::io::Cursor;
use std::rc::Rc;

struct CountingReader<R> {
    reader: R,
    bytes: Rc<Cell<u64>>,
}

impl<R: Read> Read for CountingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let count = self.reader.read(buffer)?;
        self.bytes.set(self.bytes.get() + count as u64);
        Ok(count)
    }
}

fn header(kind: tar::EntryType, size: u64) -> io::Result<tar::Header> {
    let mut header = tar::Header::new_gnu();
    header.set_path("member")?;
    header.set_entry_type(kind);
    header.set_size(size);
    header.set_mode(0o644);
    header.set_cksum();
    Ok(header)
}

fn append(data: &mut Vec<u8>, header: &tar::Header, body: &[u8]) {
    data.extend_from_slice(header.as_bytes());
    data.extend_from_slice(body);
    data.resize(data.len().next_multiple_of(512), 0);
}

fn count_members(reader: impl Read, bytes: Rc<Cell<u64>>) -> io::Result<usize> {
    let budget = MetadataBudget::default();
    let reader = CountingReader { reader, bytes };
    let mut archive = tar::Archive::new(MetadataReader::new(reader, &budget));
    let mut entries = archive.entries()?;
    let mut count = 0;
    loop {
        budget.begin_entry();
        let Some(entry) = entries.next() else {
            return Ok(count);
        };
        budget.allow_payload(&mut entry?)?;
        count += 1;
        // Leave the payload unread: the next iterator call must skip physical
        // data without charging it to metadata or expanding sparse holes.
    }
}

#[test]
fn oversized_extensions_stop_after_bounded_reads() -> io::Result<()> {
    for kind in [
        tar::EntryType::XHeader,
        tar::EntryType::GNULongName,
        tar::EntryType::GNULongLink,
    ] {
        let header = header(kind, 16 * MAX_METADATA_BYTES)?;
        let reader = Cursor::new(header.as_bytes()).chain(io::repeat(b'A'));
        let bytes = Rc::new(Cell::new(0));
        let error = count_members(reader, bytes.clone()).unwrap_err();
        assert!(error.to_string().contains("metadata exceeds"), "{error}");
        assert_eq!(bytes.get(), MAX_METADATA_BYTES);
    }
    Ok(())
}

#[test]
fn distinct_extensions_share_one_retained_metadata_budget() -> io::Result<()> {
    let mut data = Vec::new();
    let body = vec![b'A'; 400 * 1024];
    for kind in [
        tar::EntryType::GNULongName,
        tar::EntryType::GNULongLink,
        tar::EntryType::XHeader,
    ] {
        append(&mut data, &header(kind, body.len() as u64)?, &body);
    }
    let bytes = Rc::new(Cell::new(0));
    let error = count_members(Cursor::new(data), bytes.clone()).unwrap_err();
    assert!(error.to_string().contains("metadata exceeds"), "{error}");
    assert_eq!(bytes.get(), MAX_METADATA_BYTES);
    Ok(())
}

#[test]
fn exact_metadata_budget_is_accepted_and_resets_between_members() -> io::Result<()> {
    let mut data = Vec::new();
    // One extension header, its body, and one ordinary header exactly fill
    // the metadata allowance. File data and padding are separate.
    let body = vec![b'A'; MAX_METADATA_BYTES as usize - 1024];
    for _ in 0..2 {
        append(
            &mut data,
            &header(tar::EntryType::GNULongName, body.len() as u64)?,
            &body,
        );
        append(&mut data, &header(tar::EntryType::Regular, 2)?, b"ok");
    }
    let bytes = Rc::new(Cell::new(0));
    let length = data.len() as u64;
    assert_eq!(count_members(Cursor::new(data), bytes.clone())?, 2);
    assert_eq!(bytes.get(), length);
    Ok(())
}

#[test]
fn sparse_extension_headers_share_the_read_budget() -> io::Result<()> {
    let mut header = header(tar::EntryType::GNUSparse, 0)?;
    let gnu = header.as_gnu_mut().unwrap();
    gnu.set_real_size(0);
    gnu.set_is_extended(true);
    header.set_cksum();
    let mut data = header.as_bytes().to_vec();
    let mut extension = tar::GnuExtSparseHeader::new();
    extension.set_is_extended(true);
    for _ in 0..MAX_METADATA_BYTES / 512 + 1 {
        data.extend_from_slice(extension.as_bytes());
    }
    let bytes = Rc::new(Cell::new(0));
    let error = count_members(Cursor::new(data), bytes.clone()).unwrap_err();
    assert!(error.to_string().contains("metadata exceeds"), "{error}");
    assert_eq!(bytes.get(), MAX_METADATA_BYTES);
    Ok(())
}

#[test]
fn pax_size_exempts_large_unread_payloads_including_sparse_members() -> io::Result<()> {
    let body = vec![b'A'; 2 * MAX_METADATA_BYTES as usize + 17];
    for sparse in [false, true] {
        let mut data = Vec::new();
        let mut builder = tar::Builder::new(&mut data);
        let size = body.len().to_string();
        builder.append_pax_extensions([("size", size.as_bytes())])?;
        // GNU intermediary metadata must not inherit the PAX payload size.
        let name = b"member\0";
        builder.append(
            &header(tar::EntryType::GNULongName, name.len() as u64)?,
            &name[..],
        )?;
        let kind = if sparse {
            tar::EntryType::GNUSparse
        } else {
            tar::EntryType::Regular
        };
        let mut member = header(kind, 0)?;
        if sparse {
            let gnu = member.as_gnu_mut().unwrap();
            let hole = 4 * 1024 * 1024 * 1024;
            gnu.sparse[0].set_offset(hole);
            gnu.sparse[0].set_length(body.len() as u64);
            gnu.set_real_size(hole + body.len() as u64);
            member.set_cksum();
        }
        builder.append(&member, &body[..])?;
        builder.append(&header(tar::EntryType::Regular, 2)?, &b"ok"[..])?;
        builder.finish()?;
        drop(builder);
        let bytes = Rc::new(Cell::new(0));
        assert_eq!(count_members(Cursor::new(&data), bytes.clone())?, 2);
        assert!(bytes.get() <= data.len() as u64);
    }
    Ok(())
}

#[test]
fn sparse_pax_precedence_cannot_exempt_the_following_metadata() -> io::Result<()> {
    for pax in [
        b"12 size=512\n17 size=16777216\n".as_slice(),
        b"16 size=invalid\n17 size=16777216\n".as_slice(),
        b"malformed\n17 size=16777216\n".as_slice(),
    ] {
        let mut prefix = Vec::new();
        append(
            &mut prefix,
            &header(tar::EntryType::XHeader, pax.len() as u64)?,
            pax,
        );
        let mut sparse = header(tar::EntryType::GNUSparse, 512)?;
        let gnu = sparse.as_gnu_mut().unwrap();
        gnu.set_real_size(512);
        gnu.sparse[0].set_offset(0);
        gnu.sparse[0].set_length(512);
        sparse.set_cksum();
        append(&mut prefix, &sparse, &[b'A'; 512]);
        let member_end = prefix.len() as u64;
        prefix.extend_from_slice(
            header(tar::EntryType::GNULongName, 16 * MAX_METADATA_BYTES)?.as_bytes(),
        );
        let reader = Cursor::new(prefix).chain(io::repeat(b'A'));
        let bytes = Rc::new(Cell::new(0));
        let error = count_members(reader, bytes.clone()).unwrap_err();
        assert!(error.to_string().contains("metadata exceeds"), "{error}");
        assert_eq!(bytes.get(), member_end + MAX_METADATA_BYTES);
    }
    Ok(())
}

#[test]
fn yielded_global_metadata_is_bounded_before_its_payload() -> io::Result<()> {
    let header = header(tar::EntryType::XGlobalHeader, MAX_METADATA_BYTES + 1)?;
    let bytes = Rc::new(Cell::new(0));
    let error = count_members(Cursor::new(header.as_bytes()), bytes.clone()).unwrap_err();
    assert!(error.to_string().contains("metadata exceeds"), "{error}");
    assert_eq!(bytes.get(), 512);
    Ok(())
}

#[test]
fn yielded_global_metadata_counts_its_header_and_padding() -> io::Result<()> {
    for size in [MAX_METADATA_BYTES - 512, MAX_METADATA_BYTES - 511] {
        let header = header(tar::EntryType::XGlobalHeader, size)?;
        let reader = Cursor::new(header.as_bytes()).chain(io::repeat(b'A').take(size));
        let bytes = Rc::new(Cell::new(0));
        let result = count_members(reader, bytes.clone());
        if size == MAX_METADATA_BYTES - 512 {
            assert_eq!(result?, 1);
            assert_eq!(bytes.get(), MAX_METADATA_BYTES);
        } else {
            assert!(result.unwrap_err().to_string().contains("metadata exceeds"));
            assert_eq!(bytes.get(), 512);
        }
    }
    Ok(())
}

#[test]
fn empty_reads_do_not_fail_at_the_metadata_limit() -> io::Result<()> {
    let budget = MetadataBudget::default();
    let mut reader = MetadataReader::new(io::empty(), &budget);
    assert_eq!(reader.read(&mut [])?, 0);
    assert_eq!(
        reader.read(&mut [0]).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    Ok(())
}
