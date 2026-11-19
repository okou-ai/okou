//! Direct guest file writer used by guest-control-server.
//!
//! Accepted syntax:
//!
//! ```text
//! guest-write-file [--append] [--] <path>
//! guest-write-file --create-parents [--] <path>
//! guest-write-file --private [--append] [--] <path>
//! guest-write-file --batch [--private]
//! ```
//!
//! Content is read from stdin. Create mode truncates or creates the target.
//! Append mode creates the target file when its parent already exists, matching
//! shell `>>`, but does not create missing parents.
//! Create-parents mode creates missing parent directories before writing.
//! Private mode writes through the guest runtime private file helpers, ensuring
//! parent directories are private, creating missing parent directories even
//! with append mode, and rejecting symlinked parent components.
//! `--append` and `--create-parents` cannot be combined. `--private` and
//! `--create-parents` cannot be combined; private mode creates missing parent
//! directories, including when used with `--append`.
//! Batch mode reads a `guest-control-proto` `write_files` payload from stdin and writes
//! every entry with create-parent and truncate semantics. Private batch mode
//! applies private runtime-file semantics to every entry.
//! The Linux Guest server can supply an immutable batch file on stdin via
//! `--sealed-batch`.
//! Use `--` before a path that begins with `-`.
//!
//! The detailed canonical CLI contract is documented on
//! [`guest_write_file::run_cli`](fn.run_cli.html).

use std::io;

fn main() {
    #[cfg(target_os = "linux")]
    if std::env::args_os().len() == 2
        && std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--sealed-batch"))
    {
        std::process::exit(guest_write_file::run_sealed_batch(io::stderr().lock()));
    }

    let code = guest_write_file::run_cli(
        std::env::args().skip(1),
        io::stdin().lock(),
        io::stderr().lock(),
    );
    std::process::exit(code);
}
