//! One isolated test process measures allocations across the real manifest
//! worker threads. Fixture generation and filesystem assertions are excluded.
use flate2::Compression;
use flate2::write::GzEncoder;
use httpmock::prelude::*;
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

static MEASURING: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

struct AllocationObserver;

fn record_allocation(size: usize) {
    if MEASURING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for AllocationObserver {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation(size);
        unsafe { System.realloc(pointer, layout, size) }
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: AllocationObserver = AllocationObserver;

fn file_header(size: u64) -> tar::Header {
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o644);
    header.set_cksum();
    header
}

fn oversized_metadata_archive(kind: tar::EntryType) -> io::Result<Vec<u8>> {
    let encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    builder.append_data(&mut file_header(2), "before.txt", &b"ok"[..])?;
    let bytes = 8 * 1024 * 1024;
    if kind.is_pax_local_extensions() {
        builder.append_pax_extensions([("comment", vec![b'A'; bytes].as_slice())])?;
    } else {
        let mut header = file_header(bytes as u64);
        header.set_entry_type(kind);
        header.set_cksum();
        builder.append(&header, io::repeat(b'A').take(bytes as u64))?;
    }
    builder.append_data(&mut file_header(2), "after.txt", &b"ok"[..])?;
    builder.into_inner()?.finish()
}

fn normal_metadata_archive() -> io::Result<Vec<u8>> {
    let encoder = GzEncoder::new(Vec::new(), Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    // A valid PAX size overrides a zero-sized ordinary header. The following
    // GNU long-name extension must keep its own size, not inherit PAX size.
    builder.append_pax_extensions([
        ("comment", b"ordinary metadata".as_slice()),
        ("size", b"3145745".as_slice()),
    ])?;
    let path = format!("nested/{}/payload.bin", "a".repeat(120));
    builder.append_data(&mut file_header(0), &path, io::repeat(b'Z').take(3_145_745))?;
    let mut link = file_header(0);
    link.set_entry_type(tar::EntryType::Symlink);
    builder.append_link(&mut link, "long-link", &path)?;
    builder.append_pax_extensions([("path", b"pax-name.txt".as_slice())])?;
    builder.append_data(&mut file_header(2), "placeholder", &b"ok"[..])?;

    let mut sparse = file_header(514);
    sparse.set_entry_type(tar::EntryType::GNUSparse);
    let gnu = sparse
        .as_gnu_mut()
        .ok_or_else(|| io::Error::other("expected a GNU test header"))?;
    gnu.set_real_size(8 * 1024 * 1024 + 2);
    gnu.set_is_extended(true);
    let [first, ..] = &mut gnu.sparse;
    first.set_offset(0);
    first.set_length(512);
    let mut extension = tar::GnuExtSparseHeader::new();
    let [last, ..] = &mut extension.sparse;
    last.set_offset(8 * 1024 * 1024);
    last.set_length(2);
    let data = Cursor::new(extension.as_bytes())
        .chain(io::repeat(b'Z').take(512))
        .chain(Cursor::new(b"ok"));
    builder.append_data(&mut sparse, "sparse.bin", data)?;
    builder.append_data(&mut file_header(2), "after-sparse.txt", &b"ok"[..])?;
    builder.into_inner()?.finish()
}

fn apply(mount: &Path, url: &str) -> io::Result<(bool, usize)> {
    let manifest = serde_json::to_vec(&json!({"storageMounts": [{
        "mountPath": mount,
        "archiveUrl": url
    }]}))
    .map_err(io::Error::other)?;
    LARGEST.store(0, Ordering::Relaxed);
    MEASURING.store(true, Ordering::Relaxed);
    let result = guest_storage_apply::run_manifest_bytes(&manifest);
    MEASURING.store(false, Ordering::Relaxed);
    Ok((result, LARGEST.load(Ordering::Relaxed)))
}

#[test]
fn local_and_http_manifests_bound_metadata_allocations_and_preserve_streaming() -> io::Result<()> {
    guest_telemetry::log::clear_system_log_file();
    let dir = tempfile::tempdir()?;
    let server = MockServer::start();
    for (index, kind) in [
        tar::EntryType::XHeader,
        tar::EntryType::GNULongName,
        tar::EntryType::GNULongLink,
    ]
    .into_iter()
    .enumerate()
    {
        let archive = oversized_metadata_archive(kind)?;
        assert!(archive.len() < 64 * 1024);
        let staged = dir.path().join(format!("oversized-{index}.tar.gz"));
        std::fs::write(&staged, &archive)?;
        let route = format!("/oversized-{index}.tar.gz");
        let mut mock = server.mock(|when, then| {
            when.method(GET).path(&route);
            then.status(200).body(&archive);
        });
        for (source, url) in [
            ("local", format!("file://{}", staged.display())),
            ("http", server.url(&route)),
        ] {
            let mount = dir.path().join(format!("{source}-{index}"));
            let (success, largest) = apply(&mount, &url)?;
            // The old extractor grows an 8 MiB extension to a 16 MiB vector.
            // Allow bounded capacity overhead around the 1 MiB metadata limit.
            assert!(largest <= 4 * 1024 * 1024, "{source} {kind:?}: {largest}");
            assert!(!success, "{source} {kind:?}");
            assert_eq!(std::fs::read(mount.join("before.txt"))?, b"ok");
            assert!(!mount.join("after.txt").exists());
            eprintln!("{source} {kind:?}: largest allocation = {largest} bytes");
        }
        mock.assert_calls(1);
        mock.delete();
    }

    let archive = normal_metadata_archive()?;
    let staged = dir.path().join("normal.tar.gz");
    std::fs::write(&staged, &archive)?;
    let normal = server.mock(|when, then| {
        when.method(GET).path("/normal.tar.gz");
        then.status(200).body(&archive);
    });
    for (source, url) in [
        ("local", format!("file://{}", staged.display())),
        ("http", server.url("/normal.tar.gz")),
    ] {
        let mount = dir.path().join(format!("normal-{source}"));
        let (success, largest) = apply(&mount, &url)?;
        assert!(success, "{source}");
        assert!(largest <= 4 * 1024 * 1024, "{source}: {largest}");
        let path = format!("nested/{}/payload.bin", "a".repeat(120));
        assert_eq!(std::fs::read(mount.join(&path))?, vec![b'Z'; 3_145_745]);
        assert_eq!(
            std::fs::read_link(mount.join("long-link"))?,
            Path::new(&path)
        );
        assert_eq!(std::fs::read(mount.join("pax-name.txt"))?, b"ok");
        let mut sparse = std::fs::File::open(mount.join("sparse.bin"))?;
        assert_eq!(sparse.metadata()?.len(), 8 * 1024 * 1024 + 2);
        let mut bytes = [0; 2];
        sparse.read_exact(&mut bytes)?;
        assert_eq!(bytes, *b"ZZ");
        sparse.seek(SeekFrom::Start(512))?;
        sparse.read_exact(&mut bytes)?;
        assert_eq!(bytes, [0; 2]);
        sparse.seek(SeekFrom::End(-2))?;
        sparse.read_exact(&mut bytes)?;
        assert_eq!(bytes, *b"ok");
        assert_eq!(std::fs::read(mount.join("after-sparse.txt"))?, b"ok");
    }
    normal.assert_calls(1);
    Ok(())
}
