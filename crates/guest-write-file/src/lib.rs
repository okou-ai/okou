//! Library entry point for the `guest-write-file` helper.
//!
//! The helper copies stdin to a target file using the CLI contract documented
//! on [`run_cli`].

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

mod file_stream;

#[derive(Debug, Eq, PartialEq)]
struct Args {
    append: bool,
    batch: bool,
    create_parents: bool,
    private: bool,
    path: Option<PathBuf>,
}

const USAGE: &str = concat!(
    "usage: guest-write-file [--append] [--] <path>\n",
    "       guest-write-file --create-parents [--] <path>\n",
    "       guest-write-file --private [--append] [--] <path>\n",
    "       guest-write-file --batch [--private]\n",
    "       guest-write-file --zstd <decoded-size> [--append] [--create-parents] [--] <path>",
);

fn parse_args<I>(args: I) -> Result<Args, String>
where
    I: IntoIterator<Item = String>,
{
    let mut append = false;
    let mut batch = false;
    let mut create_parents = false;
    let mut private = false;
    let mut path = None;
    let mut positional_only = false;

    for arg in args {
        if !positional_only {
            match arg.as_str() {
                "--append" => {
                    append = true;
                    continue;
                }
                "--batch" => {
                    batch = true;
                    continue;
                }
                "--create-parents" => {
                    create_parents = true;
                    continue;
                }
                "--private" => {
                    private = true;
                    continue;
                }
                "--" => {
                    positional_only = true;
                    continue;
                }
                flag if flag.starts_with('-') => {
                    return Err(format!("unknown argument: {flag}"));
                }
                _ => {}
            }
        }

        if path.replace(PathBuf::from(&arg)).is_some() {
            return Err("expected exactly one path".to_string());
        }
    }

    if batch {
        if append || create_parents {
            return Err("--batch cannot be used with --append or --create-parents".to_string());
        }
        if path.is_some() {
            return Err("--batch does not accept a path".to_string());
        }
        return Ok(Args {
            append: false,
            batch: true,
            create_parents: false,
            private,
            path: None,
        });
    }

    let path = path.ok_or_else(|| "missing path".to_string())?;
    if append && create_parents {
        return Err("--append and --create-parents cannot be used together".to_string());
    }
    if private && create_parents {
        return Err("--private and --create-parents cannot be used together".to_string());
    }

    Ok(Args {
        append,
        batch: false,
        create_parents,
        private,
        path: Some(path),
    })
}

fn run(args: Args, mut stdin: impl Read) -> io::Result<()> {
    if args.batch {
        return run_batch(stdin, args.private);
    }
    let Some(path) = args.path else {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "missing path"));
    };

    let mut file = if args.private {
        open_private_output_file(&path, args.append)?
    } else {
        if args.create_parents
            && let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)?;
        }
        open_output_file(&path, args.append)?
    };

    io::copy(&mut stdin, &mut file)?;
    file.flush()
}

fn run_batch(mut stdin: impl Read, private: bool) -> io::Result<()> {
    let mut payload = Vec::new();
    let max_payload_size =
        guest_control_proto::MAX_MESSAGE_SIZE - guest_control_proto::MIN_BODY_SIZE;
    let mut limited = stdin.by_ref().take(max_payload_size as u64 + 1);
    limited.read_to_end(&mut payload)?;
    if payload.len() > max_payload_size {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "write_files payload exceeds maximum protocol message size",
        ));
    }
    let files = guest_control_proto::decode_write_files(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;

    for file in files {
        let path = Path::new(file.path);
        let mut output = if private {
            open_private_output_file(path, false)?
        } else {
            if let Some(parent) = path.parent()
                && !parent.as_os_str().is_empty()
            {
                fs::create_dir_all(parent)?;
            }
            open_output_file(path, false)?
        };
        output.write_all(file.content)?;
        output.flush()?;
    }
    Ok(())
}

fn open_private_output_file(path: &Path, append: bool) -> io::Result<File> {
    if append {
        guest_contracts::runtime_paths::open_private_append(path)
    } else {
        guest_contracts::runtime_paths::create_private(path)
    }
}

fn open_output_file(path: &Path, append: bool) -> io::Result<File> {
    let file = output_options(append).open(path)?;
    prepare_output_file(&file)?;
    Ok(file)
}

fn output_options(append: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }

    options
}

#[cfg(unix)]
fn prepare_output_file(file: &File) -> io::Result<()> {
    use std::os::unix::io::AsRawFd;

    let fd = file.as_raw_fd();
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: `stat` points to valid writable memory and `fd` comes from a
    // live File. On success, fstat initializes the whole struct.
    let result = unsafe { libc::fstat(fd, stat.as_mut_ptr()) };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fstat succeeded and initialized `stat`.
    let stat = unsafe { stat.assume_init() };
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target is not a regular file",
        ));
    }

    // `O_NONBLOCK` is only used to keep opening FIFOs/special files from
    // hanging. Regular-file writes should keep normal blocking semantics.
    // SAFETY: `fd` comes from a live File and F_GETFL only reads descriptor
    // status flags.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_NONBLOCK != 0 {
        // SAFETY: `fd` comes from a live File. F_SETFL updates descriptor
        // status flags and leaves the open file description otherwise intact.
        let result = unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
    }

    Ok(())
}

#[cfg(not(unix))]
fn prepare_output_file(_file: &File) -> io::Result<()> {
    Ok(())
}

/// Runs the `guest-write-file` CLI.
///
/// `args` must contain the command-line arguments after the executable name,
/// matching `std::env::args().skip(1)`. The accepted syntax is:
///
/// ```text
/// guest-write-file [--append] [--] <path>
/// guest-write-file --create-parents [--] <path>
/// guest-write-file --private [--append] [--] <path>
/// guest-write-file --batch [--private]
/// guest-write-file --zstd <decoded-size> [--append | --create-parents] [--] <path>
/// ```
///
/// Use `--` before `<path>` when the literal path begins with `-`. `stdin`
/// provides the complete file content and `stderr` receives diagnostics.
///
/// By default, the target file is created or truncated before writing.
/// `--append` appends to the target file and creates it only when the parent
/// directory already exists. `--create-parents` creates missing parent
/// directories before writing. `--private` writes through the guest runtime
/// private file helpers, ensuring parent directories are private, creating
/// missing parent directories even with `--append`, and rejecting symlinked
/// parent components.
/// `--append` and `--create-parents` cannot be used together. `--private` and
/// `--create-parents` cannot be used together because private mode already
/// creates missing parent directories, including when combined with
/// `--append`.
///
/// `--batch` reads a `guest-control-proto` `write_files` payload from stdin and writes
/// every entry with create-parent and truncate semantics. Combined with
/// `--private`, every entry uses the private runtime-file behavior described
/// above.
///
/// `--zstd` reads exactly one checksummed zstd frame and writes its decoded
/// bytes using ordinary file semantics. Decoded requests are at most 15 MiB,
/// with a 16 MiB decoder window. Private and batch modes are not supported.
/// A decode or write failure may leave partial bytes just like an ordinary write;
/// callers that need atomic replacement must stage and rename the complete file.
///
/// Returns process-style exit codes: `0` for success, `1` for runtime or write
/// failures, and `2` for usage or argument errors.
pub fn run_cli<I>(args: I, stdin: impl Read, mut stderr: impl Write) -> i32
where
    I: IntoIterator<Item = String>,
{
    let args: Vec<String> = args.into_iter().collect();
    if args.first().is_some_and(|arg| arg == "--zstd") {
        return file_stream::run(args, stdin, stderr);
    }
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(e) => {
            let _ = writeln!(stderr, "guest-write-file: {e}");
            let _ = writeln!(stderr, "{USAGE}");
            return 2;
        }
    };

    if let Err(e) = run(args, stdin) {
        let _ = writeln!(stderr, "guest-write-file: {e}");
        return 1;
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_create_parents() {
        let args =
            parse_args(["--create-parents".to_string(), "/tmp/out.txt".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                append: false,
                batch: false,
                create_parents: true,
                private: false,
                path: Some(PathBuf::from("/tmp/out.txt")),
            }
        );
    }

    #[test]
    fn parse_append_after_separator_path_starting_with_dash() {
        let args = parse_args([
            "--append".to_string(),
            "--".to_string(),
            "-literal".to_string(),
        ])
        .unwrap();

        assert_eq!(
            args,
            Args {
                append: true,
                batch: false,
                create_parents: false,
                private: false,
                path: Some(PathBuf::from("-literal")),
            }
        );
    }

    #[test]
    fn rejects_extra_path() {
        let err = parse_args(["/tmp/a".to_string(), "/tmp/b".to_string()]).unwrap_err();

        assert!(err.contains("exactly one path"));
    }

    #[test]
    fn rejects_unknown_flag() {
        let err = parse_args(["--unknown".to_string(), "/tmp/a".to_string()]).unwrap_err();

        assert!(err.contains("unknown argument"));
    }

    #[test]
    fn rejects_append_with_create_parents() {
        let err = parse_args([
            "--append".to_string(),
            "--create-parents".to_string(),
            "/tmp/a".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("cannot be used together"));
    }

    #[test]
    fn parse_private_append() {
        let args = parse_args([
            "--private".to_string(),
            "--append".to_string(),
            "/tmp/out.txt".to_string(),
        ])
        .unwrap();

        assert_eq!(
            args,
            Args {
                append: true,
                batch: false,
                create_parents: false,
                private: true,
                path: Some(PathBuf::from("/tmp/out.txt")),
            }
        );
    }

    #[test]
    fn parse_batch() {
        let args = parse_args(["--batch".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                append: false,
                batch: true,
                create_parents: false,
                private: false,
                path: None,
            }
        );
    }

    #[test]
    fn parse_private_batch() {
        let args = parse_args(["--batch".to_string(), "--private".to_string()]).unwrap();

        assert_eq!(
            args,
            Args {
                append: false,
                batch: true,
                create_parents: false,
                private: true,
                path: None,
            }
        );
    }

    #[test]
    fn rejects_batch_with_path() {
        let err = parse_args(["--batch".to_string(), "/tmp/out.txt".to_string()]).unwrap_err();

        assert!(err.contains("does not accept a path"));
    }

    #[test]
    fn rejects_batch_with_single_file_flags() {
        let err = parse_args(["--batch".to_string(), "--create-parents".to_string()]).unwrap_err();

        assert!(err.contains("cannot be used"));
    }

    #[test]
    fn rejects_private_with_create_parents() {
        let err = parse_args([
            "--private".to_string(),
            "--create-parents".to_string(),
            "/tmp/a".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("cannot be used together"));
    }
}
