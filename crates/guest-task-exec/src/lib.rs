//! Internal managed runtime launcher. No target executes before broker ACK.

use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

use guest_contracts::managed_task::{TaskHandle, TaskStartup, is_task_runtime_path};
use guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;
use process_control_ipc::managed_task::{self as ipc, TaskReply, TaskRequest};

const PLACEMENT_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(20);

enum Invocation {
    Launch {
        report_fd: RawFd,
        program: OsString,
        arguments: Vec<OsString>,
    },
    Stop(TaskHandle),
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn invocation(arguments: &[OsString]) -> io::Result<Invocation> {
    if let [mode, handle] = arguments
        && mode == "stop"
    {
        return TaskHandle::parse(
            handle
                .to_str()
                .ok_or_else(|| invalid("invalid task handle"))?
                .to_owned(),
        )
        .map(Invocation::Stop);
    }
    let [option, fd, separator, program, rest @ ..] = arguments else {
        return Err(invalid(
            "expected --report-fd <private-fd> -- <program> [args...] or stop <handle>",
        ));
    };
    if option != "--report-fd" || separator != "--" || program.is_empty() {
        return Err(invalid("invalid task launch arguments"));
    }
    let fd = fd.to_str().ok_or_else(|| invalid("invalid report FD"))?;
    if fd.is_empty() || !fd.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid("invalid report FD"));
    }
    let fd = fd
        .parse::<RawFd>()
        .map_err(|_| invalid("invalid report FD"))?;
    if fd < 3 {
        return Err(invalid("report FD must be separate from standard IO"));
    }
    Ok(Invocation::Launch {
        report_fd: fd,
        program: program.clone(),
        arguments: rest.to_vec(),
    })
}

fn connect(timeout: Duration) -> io::Result<UnixStream> {
    let tool = env::var(CANONICAL_TOOL_CGROUP_PROCS_ENV)
        .map_err(|_| invalid("managed task capability is missing or invalid"))?;
    if tool.is_empty() {
        return Err(invalid("managed task capability is empty"));
    }
    let stream = process_control_ipc::connect_abstract_with_timeout(
        &ipc::endpoint(&tool),
        PLACEMENT_TIMEOUT,
    )
    .map_err(|error| {
        io::Error::new(
            error.kind(),
            "Guest managed tasks are unavailable (unsupported Guest or stopped operation)",
        )
    })?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    // Authenticate the privileged broker, not an environment-selected user socket.
    let mut credentials = unsafe { std::mem::zeroed::<libc::ucred>() };
    let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: stream is connected and the output buffers have the correct size.
    if unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut size,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    if size as usize != std::mem::size_of::<libc::ucred>() || credentials.uid != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "task broker is not privileged",
        ));
    }
    Ok(stream)
}

fn report_pipe(fd: RawFd) -> io::Result<File> {
    // SAFETY: fcntl does not dereference pointers for these operations.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if flags & libc::O_ACCMODE == libc::O_RDONLY {
        return Err(invalid("report FD is not writable"));
    }
    // SAFETY: zeroed stat is a valid output buffer for fstat.
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    // SAFETY: fd is open and stat is a correctly sized output buffer.
    if unsafe { libc::fstat(fd, &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if !matches!(stat.st_mode & libc::S_IFMT, libc::S_IFIFO | libc::S_IFSOCK) {
        return Err(invalid("report FD must be a private pipe or socket"));
    }
    // Use a bounded private write even if the parent is not draining its pipe.
    // SAFETY: flags came from F_GETFL; this modifies only the consumed report FD.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the explicitly supplied report descriptor is consumed exactly once.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn write_report(mut report: File, task: &TaskStartup) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(task).map_err(io::Error::other)?;
    bytes.push(b'\n');
    let deadline = Instant::now() + PLACEMENT_TIMEOUT;
    let mut remaining = bytes.as_slice();
    while !remaining.is_empty() {
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "task report pipe is not draining",
            ));
        }
        match report.write(remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "task startup report failed",
                ));
            }
            Ok(written) => {
                remaining = remaining
                    .get(written..)
                    .ok_or_else(|| invalid("invalid report write length"))?
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                let mut pollfd = libc::pollfd {
                    fd: report.as_raw_fd(),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY: one initialized poll entry refers to the owned report pipe.
                if unsafe { libc::poll(&mut pollfd, 1, 10) } < 0
                    && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok(()) // report FD closes before target exec; all other program pipes survive.
}

fn place(report: File) -> io::Result<()> {
    let mut stream = connect(PLACEMENT_TIMEOUT)?;
    ipc::write_request(&mut stream, &TaskRequest::Launch {})?;
    let task = match ipc::read_reply_with_timeout(&stream, PLACEMENT_TIMEOUT)? {
        TaskReply::Ready { task } => task,
        TaskReply::Rejected { diagnostic } => return Err(io::Error::other(diagnostic)),
        TaskReply::Stopped {} => return Err(invalid("unexpected task admission response")),
    };
    if task.pid != std::process::id() {
        return Err(invalid("task launcher identity mismatch"));
    }
    let placement: OwnedFd = process_control_ipc::receive_tool_placement(&stream)?;
    loop {
        // SAFETY: placement is write-only and the one-byte buffer is valid.
        let written = unsafe { libc::write(placement.as_raw_fd(), b"0".as_ptr().cast(), 1) };
        if written == 1 {
            break;
        }
        if written < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(io::Error::last_os_error());
    }
    drop(placement);
    let membership = std::fs::read_to_string("/proc/self/cgroup")?;
    let path = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .ok_or_else(|| invalid("unified cgroup membership missing"))?;
    if !is_task_runtime_path(path)
        || !path.ends_with(&format!("/task-{}/runtime", task.handle.as_str()))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "task placement did not enter the assigned runtime",
        ));
    }
    // Migration retains inherited oom_score_adj=1000. Reset only this runtime;
    // ordinary tools still set 1000. Do not allocate protected main-runtime memory.
    std::fs::write("/proc/self/oom_score_adj", "0")?;
    process_control_ipc::write_tool_placement_confirmation(&stream)?;
    process_control_ipc::read_tool_placement_ack(&stream)?;
    drop(stream);
    write_report(report, &task)
}

fn stop(handle: TaskHandle) -> io::Result<()> {
    let mut stream = connect(STOP_TIMEOUT)?;
    ipc::write_request(&mut stream, &TaskRequest::Stop { handle })?;
    match ipc::read_reply_with_timeout(&stream, STOP_TIMEOUT)? {
        TaskReply::Stopped {} => Ok(()),
        TaskReply::Rejected { diagnostic } => Err(io::Error::other(diagnostic)),
        TaskReply::Ready { .. } => Err(invalid("unexpected task stop response")),
    }
}

/// Launch or stop an operation-owned task through the authenticated broker.
pub fn run() -> ExitCode {
    let arguments: Vec<_> = env::args_os().skip(1).collect();
    let result = match invocation(&arguments) {
        Ok(Invocation::Stop(handle)) => stop(handle),
        Ok(Invocation::Launch {
            report_fd,
            program,
            arguments,
        }) => match report_pipe(report_fd).and_then(place) {
            Ok(()) => {
                let error = Command::new(program).args(arguments).exec();
                eprintln!("guest task exec: target exec failed: {error}");
                return ExitCode::from(126);
            }
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("guest task exec: {error}");
            ExitCode::from(125)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn private_channel_is_mandatory_and_program_inputs_are_preserved() {
        let parsed = invocation(&args(&[
            "--report-fd",
            "3",
            "--",
            "/bin/python3",
            "-c",
            "a b",
            "",
        ]))
        .unwrap();
        assert!(
            matches!(parsed, Invocation::Launch { report_fd: 3, program, arguments } if program == OsStr::new("/bin/python3") && arguments == args(&["-c", "a b", ""]))
        );
        for values in [
            vec![],
            vec!["--report-fd", "1", "--", "true"],
            vec!["--report-fd", "-3", "--", "true"],
            vec!["--report-fd", "3", "true"],
            vec!["--report-fd", "3", "--", ""],
            vec!["stop", "1"],
        ] {
            assert!(invocation(&args(&values)).is_err());
        }
    }

    #[test]
    fn closed_and_standard_report_fds_fail_before_connect() {
        assert!(report_pipe(-1).is_err());
        let read_only = File::open("/dev/null").unwrap();
        assert!(report_pipe(read_only.as_raw_fd()).is_err());
    }
}
