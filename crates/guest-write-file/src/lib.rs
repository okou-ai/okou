//! Library entry point for the `guest-write-file` helper.
//!
//! The helper copies stdin to a target file using the CLI contract documented
//! on [`run_cli`].

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod sealed_batch;
#[cfg(target_os = "linux")]
pub use sealed_batch::run_sealed_batch;

const MAX_BATCH_PAYLOAD_BYTES: usize =
    guest_control_proto::MAX_MESSAGE_SIZE - guest_control_proto::MIN_BODY_SIZE;

#[derive(Debug, Eq, PartialEq)]
enum Args {
    Single { path: PathBuf, output: OutputMode },
    Batch { output: OutputMode },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OutputMode {
    Ordinary { append: bool },
    CreateParents,
    Private { append: bool },
}

impl OutputMode {
    fn open(self, path: &Path) -> io::Result<File> {
        let append = match self {
            Self::Private { append: true } => {
                return guest_contracts::runtime_paths::open_private_append(path);
            }
            Self::Private { append: false } => {
                return guest_contracts::runtime_paths::create_private(path);
            }
            Self::Ordinary { append } => append,
            Self::CreateParents => {
                if let Some(parent) = path.parent()
                    && !parent.as_os_str().is_empty()
                {
                    fs::create_dir_all(parent)?;
                }
                false
            }
        };
        let file = output_options(append).open(path)?;
        prepare_output_file(&file)?;
        Ok(file)
    }
}

const USAGE: &str = concat!(
    "usage: guest-write-file [--append] [--] <path>\n",
    "       guest-write-file --create-parents [--] <path>\n",
    "       guest-write-file --private [--append] [--] <path>\n",
    "       guest-write-file --batch [--private]",
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
        let output = if private {
            OutputMode::Private { append: false }
        } else {
            OutputMode::CreateParents
        };
        return Ok(Args::Batch { output });
    }

    let path = path.ok_or_else(|| "missing path".to_string())?;
    if append && create_parents {
        return Err("--append and --create-parents cannot be used together".to_string());
    }
    if private && create_parents {
        return Err("--private and --create-parents cannot be used together".to_string());
    }

    let output = if private {
        OutputMode::Private { append }
    } else if create_parents {
        OutputMode::CreateParents
    } else {
        OutputMode::Ordinary { append }
    };
    Ok(Args::Single { path, output })
}

fn run(args: Args, mut stdin: impl Read) -> io::Result<()> {
    match args {
        Args::Single { path, output } => {
            let mut file = output.open(&path)?;
            io::copy(&mut stdin, &mut file)?;
            file.flush()
        }
        Args::Batch { output } => run_batch(stdin, output),
    }
}

fn run_batch(mut stdin: impl Read, output: OutputMode) -> io::Result<()> {
    let mut payload = Vec::new();
    let mut limited = stdin.by_ref().take(MAX_BATCH_PAYLOAD_BYTES as u64 + 1);
    limited.read_to_end(&mut payload)?;
    if payload.len() > MAX_BATCH_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "write_files payload exceeds maximum protocol message size",
        ));
    }
    write_batch(&payload, output)
}

fn write_batch(payload: &[u8], mode: OutputMode) -> io::Result<()> {
    write_batch_with(payload, mode, |output, content| output.write_all(content))
}

fn write_batch_with(
    payload: &[u8],
    mode: OutputMode,
    mut write_content: impl FnMut(&mut File, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    let files = guest_control_proto::decode_write_files(payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;

    for file in files {
        let mut output = mode.open(Path::new(file.path))?;
        write_content(&mut output, file.content)?;
        output.flush()?;
    }
    Ok(())
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
    use nix::fcntl::{FcntlArg, OFlag, fcntl};

    let stat = nix::sys::stat::fstat(file)?;
    if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "target is not a regular file",
        ));
    }

    // `O_NONBLOCK` is only used to keep opening FIFOs/special files from
    // hanging. Regular-file writes should keep normal blocking semantics.
    let flags = OFlag::from_bits_retain(fcntl(file, FcntlArg::F_GETFL)?);
    if flags.contains(OFlag::O_NONBLOCK) {
        fcntl(file, FcntlArg::F_SETFL(flags.difference(OFlag::O_NONBLOCK)))?;
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
/// Returns process-style exit codes: `0` for success, `1` for runtime or write
/// failures, and `2` for usage or argument errors.
pub fn run_cli<I>(args: I, stdin: impl Read, mut stderr: impl Write) -> i32
where
    I: IntoIterator<Item = String>,
{
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
mod tests;
