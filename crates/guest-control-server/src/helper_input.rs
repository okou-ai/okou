use std::io::{self, Write};
use std::process::ChildStdin;
use std::thread::{self, JoinHandle};

pub(crate) struct FixedInputWriter {
    handle: JoinHandle<io::Result<()>>,
}

impl FixedInputWriter {
    pub(crate) fn spawn(
        mut stdin: ChildStdin,
        input: impl AsRef<[u8]> + Send + 'static,
        thread_name: &'static str,
    ) -> io::Result<Self> {
        let handle = thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || {
                let result = stdin.write_all(input.as_ref());
                drop(stdin);
                result
            })?;
        Ok(Self { handle })
    }

    pub(crate) fn join(self) -> io::Result<()> {
        self.handle
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    }
}
