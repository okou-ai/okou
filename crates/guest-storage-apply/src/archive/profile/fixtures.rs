use flate2::Compression;
use flate2::write::GzEncoder;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::UNIX_EPOCH;

const MTIME: u64 = 1_700_000_000;
const MODE: u32 = 0o640;

#[derive(Clone, Copy)]
pub(super) struct Case {
    pub name: &'static str,
    pub files: usize,
    pub bytes_per_file: usize,
    pub depth: usize,
    pub compressible: bool,
}

pub(super) const CASES: [Case; 4] = [
    Case {
        name: "small_many_files",
        files: 128,
        bytes_per_file: 2048,
        depth: 2,
        compressible: true,
    },
    Case {
        name: "tiny_high_fanout",
        files: 1024,
        bytes_per_file: 128,
        depth: 6,
        compressible: true,
    },
    Case {
        name: "large_compressible",
        files: 8,
        bytes_per_file: 256 * 1024,
        depth: 1,
        compressible: true,
    },
    Case {
        name: "large_incompressible",
        files: 8,
        bytes_per_file: 256 * 1024,
        depth: 1,
        compressible: false,
    },
];

struct ExpectedFile {
    path: String,
    content: Vec<u8>,
}

pub(super) struct Fixture {
    pub case: Case,
    pub archive: Vec<u8>,
    files: Vec<ExpectedFile>,
}

impl Fixture {
    pub fn new(case: Case) -> io::Result<Self> {
        Self::with_padding(case, 0)
    }

    pub fn with_padding(case: Case, padding_bytes: usize) -> io::Result<Self> {
        let directory = (0..case.depth)
            .map(|depth| format!("d{depth}"))
            .collect::<Vec<_>>()
            .join("/");
        let mut files = Vec::new();
        let mut tar = tar::Builder::new(Vec::new());
        for index in 0..case.files {
            let path = format!("{directory}/file-{index:06}.bin");
            let content = contents(case.bytes_per_file, case.compressible, index);
            let mut header = tar::Header::new_gnu();
            header.set_size(content.len() as u64);
            header.set_mode(MODE);
            header.set_mtime(MTIME);
            header.set_cksum();
            tar.append_data(&mut header, &path, content.as_slice())?;
            files.push(ExpectedFile { path, content });
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&tar.into_inner()?)?;
        gzip.write_all(&vec![0; padding_bytes])?;
        Ok(Self {
            case,
            archive: gzip.finish()?,
            files,
        })
    }

    pub fn verify(&self, target: &Path) -> io::Result<()> {
        for expected in &self.files {
            let path = target.join(&expected.path);
            if fs::read(&path)? != expected.content {
                return Err(io::Error::other("profile fixture content mismatch"));
            }
            let metadata = fs::metadata(&path)?;
            if metadata.permissions().mode() & 0o777 != MODE
                || metadata
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .map_err(io::Error::other)?
                    .as_secs()
                    != MTIME
            {
                return Err(io::Error::other("profile fixture metadata mismatch"));
            }
        }
        Ok(())
    }
}

fn contents(bytes: usize, compressible: bool, index: usize) -> Vec<u8> {
    if compressible {
        return vec![b'a' + (index % 26) as u8; bytes];
    }
    // A fixed nonzero xorshift seed produces deterministic, poorly compressible input.
    let mut state = 0x6d2b_79f5_u32.wrapping_add(index as u32);
    (0..bytes)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect()
}
