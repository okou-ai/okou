//! Observe a terminal Guest's Memory tree after its exclusive cleanup check.
//! Pending, unusual, or failed observations produce no reuse proof.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::time::{Duration, Instant};

use api_contracts::generated::constants::runners::paths::CANONICAL_GUEST_HOME_DIR;
use guest_contracts::memory_tree;
use rustix::fs::{AtFlags, Statx, StatxFlags, flistxattr_query, statx};
use sha2::{Digest, Sha256};

use crate::nofollow_fs::{Dir, FileIdentity, file_identity};

const GUEST_USER_ID: u32 = 1000;
const GUEST_GROUP_ID: u32 = 1000;
const INSPECTION_BUDGET: Duration = Duration::from_millis(100);

pub(crate) fn capture(mount: &str) -> io::Result<[u8; 32]> {
    let relative = memory_tree::mount_relative_to_home(mount).ok_or_else(unavailable)?;
    let mut root = Dir::open_absolute(Path::new(CANONICAL_GUEST_HOME_DIR))?;
    let device = root.identity()?;
    for part in relative.split('/') {
        let dir = root.as_file().metadata()?;
        use std::os::unix::fs::MetadataExt as _;
        // A full restore would inherit a parent ACL or setgid directory.
        if dir.mode() & 0o2000 != 0 || flistxattr_query(root.as_file())? != 0 {
            return Err(unavailable());
        }
        root = root.open_child_dir(part.as_ref())?;
        root.identity()?.ensure_same_mount(device)?;
    }
    let mut scan = TreeScan {
        device,
        deadline: Instant::now() + INSPECTION_BUDGET,
        files: BTreeMap::new(),
        directories: BTreeSet::new(),
        path_bytes: 0,
        content_bytes: 0,
    };
    scan.walk(&root, "")?;
    let expected = memory_tree::parent_directories(scan.files.keys().map(String::as_str))
        .ok_or_else(unavailable)?;
    if !scan.directories.iter().map(String::as_str).eq(expected) {
        return Err(unavailable());
    }
    Ok(memory_tree::digest(&scan.files))
}

struct TreeScan {
    device: FileIdentity,
    deadline: Instant,
    files: BTreeMap<String, memory_tree::FileState>,
    directories: BTreeSet<String>,
    path_bytes: usize,
    content_bytes: u64,
}

impl TreeScan {
    fn walk(&mut self, dir: &Dir, relative: &str) -> io::Result<()> {
        let state = plain_inode(dir.as_file(), self.device)?;
        // The normal storage helper creates tar's implicit directories with
        // the Guest workload identity and default umask.
        if state.stx_mode & 0o7777 != 0o755 {
            return Err(unavailable());
        }
        for entry in dir.read_dir()? {
            if Instant::now() >= self.deadline {
                return Err(unavailable());
            }
            let entry = entry?;
            let name = entry.file_name();
            let basename = name.to_str().ok_or_else(unavailable)?;
            let path = if relative.is_empty() {
                basename.to_owned()
            } else {
                format!("{relative}/{basename}")
            };
            self.path_bytes += path.len();
            if !memory_tree::valid_file_path(&path) || self.path_bytes > memory_tree::MAX_PATH_BYTES
            {
                return Err(unavailable());
            }
            let file_type = entry.file_type()?;
            if file_type.is_dir() && self.directories.len() + 1 < memory_tree::MAX_DIRECTORIES {
                let child = dir.open_child_dir(&name)?;
                self.directories.insert(path.clone());
                self.walk(&child, &path)?;
            } else if file_type.is_file() && self.files.len() < memory_tree::MAX_FILES {
                let file = dir.open_child_file(&name)?;
                let state = self.read_file(file)?;
                self.files.insert(path, state);
            } else {
                return Err(unavailable());
            }
        }
        Ok(())
    }

    fn read_file(&mut self, file: File) -> io::Result<memory_tree::FileState> {
        let state = plain_inode(&file, self.device)?;
        self.content_bytes = self.content_bytes.saturating_add(state.stx_size);
        if self.content_bytes > memory_tree::MAX_CONTENT_BYTES
            || state.stx_nlink != 1
            || state.stx_mode & libc::S_IFMT as u16 != libc::S_IFREG as u16
            || state.stx_mode & 0o7000 != 0
            || state.stx_mtime.tv_sec < 1
            || state.stx_mtime.tv_nsec != 0
        {
            return Err(unavailable());
        }
        let mut sha256 = Sha256::new();
        let mut file = file.take(state.stx_size + 1);
        let mut buffer = [0; 8192];
        let mut seen = 0;
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            if Instant::now() >= self.deadline {
                return Err(unavailable());
            }
            seen += n as u64;
            sha256.update(buffer.get(..n).ok_or_else(unavailable)?);
        }
        if seen != state.stx_size {
            return Err(unavailable());
        }
        Ok(memory_tree::FileState {
            sha256: sha256.finalize().into(),
            mode: u32::from(state.stx_mode & 0o777),
            mtime: state.stx_mtime.tv_sec as u64,
        })
    }
}

fn plain_inode(file: &File, device: FileIdentity) -> io::Result<Statx> {
    file_identity(file)?.ensure_same_mount(device)?;
    let mask = StatxFlags::BASIC_STATS;
    let stat = statx(file, c"", AtFlags::EMPTY_PATH, mask)?;
    if !StatxFlags::from_bits_retain(stat.stx_mask).contains(mask)
        || stat.stx_uid != GUEST_USER_ID
        || stat.stx_gid != GUEST_GROUP_ID
        || !stat.stx_attributes.is_empty()
        || flistxattr_query(file)? != 0
    {
        return Err(unavailable());
    }
    Ok(stat)
}

fn unavailable() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Memory tree cannot be verified")
}
