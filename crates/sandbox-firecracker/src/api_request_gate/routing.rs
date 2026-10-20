use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use reqwest::Method;

tokio::task_local! {
    static REQUEST_ROUTE: RequestRoute;
}

/// Route one socket's actual PATCH /vm requests through a caller-owned gate.
///
/// Matching uses lexical `Path` equality without resolving symlinks or adopting
/// sockets. Other methods, endpoints and socket paths keep their own transport.
/// This is test instrumentation, not evidence of native request acceptance.
#[derive(Debug)]
pub struct RequestRoute {
    backend: PathBuf,
    front: PathBuf,
}

impl RequestRoute {
    /// Select distinct, nonempty invocation-owned backend and front paths.
    ///
    /// The caller binds the front listener and retains its gate producer and
    /// native resource owner independently of the scoped operation.
    pub fn new(backend: PathBuf, front: PathBuf) -> io::Result<Self> {
        if backend.as_os_str().is_empty() || front.as_os_str().is_empty() || backend == front {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "request route requires distinct nonempty socket paths",
            ));
        }
        Ok(Self { backend, front })
    }

    /// Poll the supplied future with this route, preserving its ownership.
    ///
    /// No operation is spawned. Context is restored when this scope completes,
    /// unwinds or is dropped, including nested scopes. Spawned tasks do not
    /// inherit the route; put the scope inside any deliberately spawned task.
    /// A selected front transport failure never retries the original backend.
    pub async fn scope<F: Future>(self, operation: F) -> F::Output {
        REQUEST_ROUTE.scope(self, operation).await
    }
}

pub(crate) fn request_socket(backend: &Path, method: &Method, path: &str) -> Option<PathBuf> {
    REQUEST_ROUTE
        .try_with(|route| {
            (route.backend == backend && method == Method::PATCH && path == "/vm")
                .then(|| route.front.clone())
        })
        .ok()
        .flatten()
}
