//! Failure-only filesystem attribution without disclosing host/workload paths.

use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
enum ContextError {
    #[error("home cache {operation} path_id={path_id}: {source}")]
    Path {
        operation: &'static str,
        path_id: String,
        #[source]
        source: io::Error,
    },
    #[error(
        "home cache {operation} source_path_id={source_path_id} destination_path_id={destination_path_id}: {source}"
    )]
    Transfer {
        operation: &'static str,
        source_path_id: String,
        destination_path_id: String,
        #[source]
        source: io::Error,
    },
}

fn path_id(path: &Path) -> String {
    hex::encode(Sha256::digest(path.as_os_str().as_bytes()))
}

/// Keep kind-based handling and the original OS error in the source chain.
pub(super) fn with_path(error: io::Error, operation: &'static str, path: &Path) -> io::Error {
    io::Error::new(
        error.kind(),
        ContextError::Path {
            operation,
            path_id: path_id(path),
            source: error,
        },
    )
}

pub(super) fn with_paths(
    error: io::Error,
    operation: &'static str,
    source: &Path,
    destination: &Path,
) -> io::Error {
    io::Error::new(
        error.kind(),
        ContextError::Transfer {
            operation,
            source_path_id: path_id(source),
            destination_path_id: path_id(destination),
            source: error,
        },
    )
}
