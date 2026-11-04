use std::io;
use std::thread::{self, JoinHandle, ScopedJoinHandle};

pub(crate) type ThreadTask<T> = Box<dyn FnOnce() -> T + Send + 'static>;

pub(crate) trait ThreadSpawner: Clone + Send + Sync + 'static {
    fn spawn<T: Send + 'static>(
        &self,
        name: &'static str,
        task: ThreadTask<T>,
    ) -> io::Result<JoinHandle<T>>;
}

#[derive(Clone, Copy, Default)]
pub(crate) struct SystemThreadSpawner;

impl ThreadSpawner for SystemThreadSpawner {
    fn spawn<T: Send + 'static>(
        &self,
        name: &'static str,
        task: ThreadTask<T>,
    ) -> io::Result<JoinHandle<T>> {
        thread::Builder::new().name(name.to_string()).spawn(task)
    }
}

pub(crate) fn spawn_scoped_named<'scope, 'env, T, F>(
    scope: &'scope thread::Scope<'scope, 'env>,
    name: &'static str,
    f: F,
) -> io::Result<ScopedJoinHandle<'scope, T>>
where
    T: Send + 'scope,
    F: FnOnce() -> T + Send + 'scope,
{
    thread::Builder::new()
        .name(name.to_string())
        .spawn_scoped(scope, f)
}

#[cfg(test)]
pub(crate) mod test_support;
