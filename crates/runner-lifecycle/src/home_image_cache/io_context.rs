//! Failure-only filesystem attribution without disclosing host/workload paths.

use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::LifecycleError;

#[derive(Debug, thiserror::Error)]
enum ContextError {
    #[error("home cache phase={phase} path_role={path_role}: {source}")]
    Publication {
        phase: &'static str,
        path_role: &'static str,
        #[source]
        source: io::Error,
    },
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

/// Owner-stage context preserves syscall attribution and kind-based handling.
pub(super) fn at_publication_phase(
    error: LifecycleError,
    phase: &'static str,
    path_role: &'static str,
) -> LifecycleError {
    match error {
        LifecycleError::Io(source) => LifecycleError::Io(io::Error::new(
            source.kind(),
            ContextError::Publication {
                phase,
                path_role,
                source,
            },
        )),
        other => other,
    }
}

pub(crate) fn publication_io_context(
    error: &LifecycleError,
) -> Option<(&'static str, &'static str)> {
    let LifecycleError::Io(error) = error else {
        return None;
    };
    match error.get_ref()?.downcast_ref::<ContextError>()? {
        ContextError::Publication {
            phase, path_role, ..
        } => Some((*phase, *path_role)),
        _ => None,
    }
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
