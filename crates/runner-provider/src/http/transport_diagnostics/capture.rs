//! Linux header-only capture. No subprocess, privilege changes or payload storage.

use std::io;
use std::mem::{size_of, size_of_val, zeroed};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

use nix::libc;
use tokio::io::unix::AsyncFd;
use tokio::time::Instant as TimerInstant;
use tracing::instrument::WithSubscriber;

use super::*;

const READ_BATCH: usize = 64;

pub(super) fn start(shared: Arc<Shared>, faults: mpsc::Receiver<Fault>) -> Option<JoinHandle<()>> {
    let runtime = match tokio::runtime::Handle::try_current() {
        Ok(runtime) => runtime,
        Err(_) => {
            shared.state().capture_status = "no_runtime";
            return None;
        }
    };
    let socket = match open().and_then(|fd| {
        // SAFETY: OwnedFd keeps the same descriptor open until AsyncFd drops it.
        unsafe { AsyncFd::register_with_interest(fd, tokio::io::Interest::READABLE) }
            .map_err(io::Error::from)
    }) {
        Ok(socket) => socket,
        Err(error) => {
            info!(target: TARGET, raw_os_error = error.raw_os_error(),
                error_kind = ?error.kind(), "API TCP capture unavailable");
            return None;
        }
    };
    shared.state().capture_status = "ready";
    info!(target: TARGET, history_seconds = HISTORY.as_secs(),
        after_failure_seconds = AFTER_FAILURE.as_secs(), MAX_CONNECTIONS, MAX_PACKETS,
        coverage = "registered_port_pairs; exact_tuple; ipv4_unfragmented_tcp; ipv6_direct_tcp; post_registration_only",
        "API TCP capture started");
    let dispatch = shared.dispatch.clone();
    Some(runtime.spawn(record(shared, socket, faults).with_subscriber(dispatch)))
}

fn set_option<T>(fd: &OwnedFd, level: i32, option: i32, value: &T) -> io::Result<()> {
    // SAFETY: value remains initialized and live for its exact byte size.
    let result = unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            level,
            option,
            std::ptr::from_ref(value).cast(),
            size_of::<T>() as libc::socklen_t,
        )
    };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn open() -> io::Result<OwnedFd> {
    // Start with protocol 0 so no traffic is delivered before the rejecting
    // filter and timestamp option are installed.
    let raw = unsafe {
        libc::socket(
            libc::AF_PACKET,
            libc::SOCK_DGRAM | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            0,
        )
    };
    if raw == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: socket returned a new descriptor, now owned exactly once.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    install_filter(&fd, &[])?;
    set_option(&fd, libc::SOL_SOCKET, libc::SO_TIMESTAMPNS, &1i32)?;
    set_option(&fd, libc::SOL_SOCKET, libc::SO_RCVBUF, &(256 * 1024i32))?;
    // SAFETY: zero is a valid initial sockaddr_ll, then required fields are set.
    let mut address: libc::sockaddr_ll = unsafe { zeroed() };
    address.sll_family = libc::AF_PACKET as u16;
    address.sll_protocol = (libc::ETH_P_ALL as u16).to_be();
    let result = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            std::ptr::from_ref(&address).cast(),
            size_of::<libc::sockaddr_ll>() as libc::socklen_t,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(fd)
}

fn instruction(code: u32, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter {
        code: code as u16,
        jt,
        jf,
        k,
    }
}

fn filter(port_pairs: &[(u16, u16)]) -> Vec<libc::sock_filter> {
    use libc::{
        BPF_A, BPF_ABS, BPF_ADD, BPF_ALU, BPF_AND, BPF_B, BPF_H, BPF_IMM, BPF_IND, BPF_JA, BPF_JEQ,
        BPF_JMP, BPF_JSET, BPF_K, BPF_LD, BPF_LDX, BPF_MSH, BPF_RET, BPF_RSH, BPF_W, BPF_X,
    };
    let i = instruction;
    let mut code = vec![
        i(BPF_LD | BPF_B | BPF_ABS, 0, 0, 0),
        i(BPF_ALU | BPF_AND | BPF_K, 0xf0, 0, 0),
        i(BPF_JMP | BPF_JEQ | BPF_K, 0x40, 2, 0), // IPv4 at 5
        i(BPF_JMP | BPF_JEQ | BPF_K, 0x60, 9, 0), // IPv6 at 13
        i(BPF_RET | BPF_K, 0, 0, 0),
        i(BPF_LD | BPF_B | BPF_ABS, 9, 0, 0),
        i(BPF_JMP | BPF_JEQ | BPF_K, 6, 1, 0),
        i(BPF_RET | BPF_K, 0, 0, 0),
        i(BPF_LD | BPF_H | BPF_ABS, 6, 0, 0),
        i(BPF_JMP | BPF_JSET | BPF_K, 0x3fff, 0, 1),
        i(BPF_RET | BPF_K, 0, 0, 0),
        i(BPF_LDX | BPF_B | BPF_MSH, 0, 0, 0),
        i(BPF_JMP | BPF_JA, 4, 0, 0), // ports at 17
        i(BPF_LD | BPF_B | BPF_ABS, 6, 0, 0),
        i(BPF_JMP | BPF_JEQ | BPF_K, 6, 1, 0),
        i(BPF_RET | BPF_K, 0, 0, 0),
        i(BPF_LDX | BPF_IMM, 40, 0, 0),
        i(BPF_LD | BPF_W | BPF_IND, 0, 0, 0),
    ];
    // Only observed local/remote port pairs reach userspace; addresses and
    // generations are checked there. Long JA offsets avoid 8-bit jump limits.
    let count = port_pairs.len() * 2;
    for (index, word) in port_pairs
        .iter()
        .flat_map(|&(a, b)| {
            [
                (u32::from(a) << 16) | u32::from(b),
                (u32::from(b) << 16) | u32::from(a),
            ]
        })
        .enumerate()
    {
        code.push(i(BPF_JMP | BPF_JEQ | BPF_K, word, 0, 1));
        code.push(i(
            BPF_JMP | BPF_JA,
            ((count - index - 1) * 2 + 1) as u32,
            0,
            0,
        ));
    }
    code.push(i(BPF_RET | BPF_K, 0, 0, 0));
    // Return exactly the IP + TCP header length, including their options.
    // The kernel discards every payload byte before delivery to the Runner.
    code.extend([
        i(BPF_LD | BPF_B | BPF_IND, 12, 0, 0),
        i(BPF_ALU | BPF_AND | BPF_K, 0xf0, 0, 0),
        i(BPF_ALU | BPF_RSH | BPF_K, 2, 0, 0),
        i(BPF_ALU | BPF_ADD | BPF_X, 0, 0, 0),
        i(BPF_RET | BPF_A, 0, 0, 0),
    ]);
    code
}

fn install_filter(fd: &OwnedFd, pairs: &[(u16, u16)]) -> io::Result<()> {
    let mut instructions = filter(pairs);
    let program = libc::sock_fprog {
        len: instructions.len() as u16,
        filter: instructions.as_mut_ptr(),
    };
    // setsockopt copies the complete program while instructions is live.
    set_option(fd, libc::SOL_SOCKET, libc::SO_ATTACH_FILTER, &program)
}

fn receive(fd: &OwnedFd) -> io::Result<Option<Packet>> {
    // Maximum direct IPv6/TCP or IPv4/TCP header including all options is 120B.
    let mut bytes = [0u8; 120];
    let mut control = [0usize; 8];
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    // SAFETY: msghdr is initialized with valid buffers for this recvmsg call.
    let mut message: libc::msghdr = unsafe { zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    // libc uses different length types on GNU and musl; this fixed buffer fits both.
    message.msg_controllen = size_of_val(&control) as _;
    let received = unsafe { libc::recvmsg(fd.as_raw_fd(), &mut message, libc::MSG_DONTWAIT) };
    if received == -1 {
        return Err(io::Error::last_os_error());
    }
    if message.msg_flags & libc::MSG_CTRUNC != 0 {
        return Ok(None);
    }
    let mut stamp = None;
    // SAFETY: CMSG helpers inspect only the initialized control buffer returned
    // by recvmsg. Check the payload size before reading the timestamp.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            if (*header).cmsg_level == libc::SOL_SOCKET
                && (*header).cmsg_type == libc::SCM_TIMESTAMPNS
                && (*header).cmsg_len >= libc::CMSG_LEN(size_of::<libc::timespec>() as u32) as _
            {
                let ts = std::ptr::read_unaligned(libc::CMSG_DATA(header).cast::<libc::timespec>());
                stamp = u64::try_from(ts.tv_sec).ok().and_then(|s| {
                    s.checked_mul(1_000_000_000)?
                        .checked_add(u64::try_from(ts.tv_nsec).ok()?)
                });
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    Ok(stamp.and_then(|stamp| parse(bytes.get(..received as usize)?, stamp)))
}

fn parse(bytes: &[u8], unix_ns: u64) -> Option<Packet> {
    let version = bytes.first()? >> 4;
    let (source, destination, offset, total) = match version {
        4 => {
            let offset = usize::from(bytes.first()? & 0x0f) * 4;
            if offset < 20 || *bytes.get(9)? != 6 || read_u16(bytes, 6)? & 0x3fff != 0 {
                return None;
            }
            let source = IpAddr::V4(Ipv4Addr::from(
                <[u8; 4]>::try_from(bytes.get(12..16)?).ok()?,
            ));
            let destination = IpAddr::V4(Ipv4Addr::from(
                <[u8; 4]>::try_from(bytes.get(16..20)?).ok()?,
            ));
            (source, destination, offset, u32::from(read_u16(bytes, 2)?))
        }
        6 => {
            if *bytes.get(6)? != 6 {
                return None;
            }
            let source = IpAddr::V6(Ipv6Addr::from(
                <[u8; 16]>::try_from(bytes.get(8..24)?).ok()?,
            ));
            let destination = IpAddr::V6(Ipv6Addr::from(
                <[u8; 16]>::try_from(bytes.get(24..40)?).ok()?,
            ));
            (source, destination, 40, u32::from(read_u16(bytes, 4)?) + 40)
        }
        _ => return None,
    };
    let tcp = bytes.get(offset..)?;
    let header_length = usize::from(tcp.get(12)? >> 4) * 4;
    if header_length < 20 || tcp.len() < header_length {
        return None;
    }
    Some(Packet {
        source: SocketAddr::new(source, read_u16(tcp, 0)?),
        destination: SocketAddr::new(destination, read_u16(tcp, 2)?),
        unix_ns,
        flags: *tcp.get(13)?,
        sequence: u32::from_be_bytes(tcp.get(4..8)?.try_into().ok()?),
        acknowledgment: u32::from_be_bytes(tcp.get(8..12)?.try_into().ok()?),
        window: read_u16(tcp, 14)?,
        payload_bytes: total.checked_sub((offset + header_length) as u32)?,
    })
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

#[repr(C)]
#[derive(Default)]
struct PacketStats {
    packets: u32,
    drops: u32,
}

fn drops(fd: &OwnedFd) -> io::Result<u32> {
    let mut stats = PacketStats::default();
    let mut length = size_of::<PacketStats>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            fd.as_raw_fd(),
            libc::SOL_PACKET,
            libc::PACKET_STATISTICS,
            std::ptr::from_mut(&mut stats).cast(),
            &mut length,
        )
    };
    if result == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(stats.drops)
    }
}

struct Pending {
    shared: Arc<Shared>,
    request_id: String,
    connection_id: u64,
    deadline: TimerInstant,
    after_seen: usize,
    after_logged: usize,
    close_logged: usize,
    complete: bool,
}

impl Drop for Pending {
    fn drop(&mut self) {
        let (kernel_drops, packet_evictions, registry_evictions, generation_status) = {
            let state = self.shared.state();
            let status = state
                .connections
                .iter()
                .find(|c| c.id == self.connection_id)
                .map_or("not_retained", |c| {
                    if c.ambiguous { "ambiguous" } else { "retained" }
                });
            (
                state.kernel_drops,
                state.evicted_packets,
                state.evicted_connections,
                status,
            )
        };
        tracing::dispatcher::with_default(&self.shared.dispatch, || {
            info!(target: TARGET, client_request_id = %self.request_id,
                connection_id = self.connection_id, after_seen = self.after_seen,
                after_logged = self.after_logged,
                after_truncated = self.after_seen > self.after_logged, ended_by_deadline = self.complete,
                generation_status,
                kernel_drops, packet_evictions, registry_evictions,
                "API TCP evidence ended");
        });
    }
}

fn log_packet(request_id: &str, phase: &'static str, record: &RecordedPacket) {
    let p = &record.packet;
    info!(target: TARGET, client_request_id = request_id,
        connection_id = record.connection_id, phase,
        packet_unix_ns = p.unix_ns, outbound = record.outbound,
        flags = p.flags, sequence = p.sequence, acknowledgment = p.acknowledgment,
        window = p.window, payload_bytes = p.payload_bytes,
        "API TCP packet metadata");
}

async fn record(shared: Arc<Shared>, socket: AsyncFd<OwnedFd>, mut faults: mpsc::Receiver<Fault>) {
    struct Lifetime(Arc<Shared>);
    impl Drop for Lifetime {
        fn drop(&mut self) {
            self.0.state().capture_status = "stopped";
        }
    }
    let _lifetime = Lifetime(Arc::clone(&shared));
    let mut pending: Vec<Pending> = Vec::new();
    let mut next_dump = TimerInstant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut batch = 0;
    loop {
        let result: io::Result<()> = tokio::select! {
            ready = socket.readable() => {
                match ready {
                    Ok(mut ready) => match ready.try_io(|fd| receive(fd.get_ref())) {
                        Ok(Ok(Some(packet))) => {
                            let (record, filter_changed) = {
                                let mut state = shared.state();
                                (state.record(packet), state.revision != state.filter_revision)
                            };
                            if filter_changed { shared.changed.notify_one(); }
                            if let Some(record) = record {
                                for incident in &mut pending {
                                    if incident.connection_id == record.connection_id && TimerInstant::now() <= incident.deadline {
                                        incident.after_seen = incident.after_seen.saturating_add(1);
                                        let close = record.packet.flags & 0x05 != 0;
                                        let admitted = if close {
                                            incident.close_logged < RESERVED_CLOSE_PACKETS
                                        } else {
                                            incident.after_logged.saturating_sub(incident.close_logged) < MAX_AFTER - RESERVED_CLOSE_PACKETS
                                        };
                                        if admitted {
                                            log_packet(&incident.request_id, "after_failure_observation", &record);
                                            incident.after_logged += 1;
                                            incident.close_logged += usize::from(close);
                                        } else if incident.after_seen == MAX_AFTER - RESERVED_CLOSE_PACKETS + 1 {
                                            info!(target: TARGET, client_request_id = %incident.request_id,
                                                bulk_packet_limit = MAX_AFTER - RESERVED_CLOSE_PACKETS, "API TCP evidence bulk limit reached");
                                        }
                                    }
                                }
                            }
                            Ok(())
                        }
                        Ok(Ok(None)) | Err(_) => Ok(()),
                        Ok(Err(error)) => Err(error),
                    },
                    Err(error) => Err(error),
                }
            }
            fault = faults.recv() => {
                let Some(fault) = fault else { break; };
                if TimerInstant::now() < next_dump || pending.len() == MAX_FAULTS {
                    info!(target: TARGET, client_request_id = %fault.request_id,
                        detail_status = "rate_limited", "API TCP evidence omitted");
                } else {
                    next_dump = TimerInstant::now() + AFTER_FAILURE;
                    info!(target: TARGET, client_request_id = %fault.request_id,
                        connection_id = fault.connection_id, before_packets = fault.before.len(),
                        fault_queue_delay_ms = millis(fault.queued.elapsed()),
                        post_window_remaining_ms = millis(fault.deadline.saturating_duration_since(TimerInstant::now())),
                        before_truncated = fault.before_truncated, "API TCP evidence started");
                    for packet in &fault.before {
                        log_packet(&fault.request_id, "before_failure_observation", packet);
                    }
                    pending.push(Pending {
                        shared: Arc::clone(&shared),
                        request_id: fault.request_id, connection_id: fault.connection_id,
                        deadline: fault.deadline, after_seen: 0, after_logged: 0, close_logged: 0, complete: false,
                    });
                }
                Ok(())
            }
            _ = shared.changed.notified() => {
                let (revision, pairs) = {
                    let state = shared.state();
                    (state.revision, state.connections.iter().filter(|c| !c.ambiguous).map(|c| (c.tuple.local.port(), c.tuple.remote.port())).collect::<Vec<_>>())
                };
                install_filter(socket.get_ref(), &pairs).map(|()| {
                    shared.state().filter_revision = revision;
                    info!(target: TARGET, revision, port_pairs = pairs.len(), filter_installed_unix_ns = unix_ns(),
                        "API TCP capture filter updated");
                })
            }
            _ = tick.tick() => {
                match drops(socket.get_ref()) {
                    Ok(drops) => {
                        let mut state = shared.state();
                        state.kernel_drops = Some(state.kernel_drops.unwrap_or_default().saturating_add(u64::from(drops)));
                    }
                    Err(error) => info!(target: TARGET, raw_os_error = error.raw_os_error(), "API TCP drop statistics unavailable"),
                }
                pending.retain_mut(|p| {
                    if TimerInstant::now() >= p.deadline { p.complete = true; false } else { true }
                });
                Ok(())
            }
        };
        if let Err(error) = result {
            shared.state().capture_status = "stopped";
            info!(target: TARGET, raw_os_error = error.raw_os_error(), error_kind = ?error.kind(),
                "API TCP capture stopped");
            break;
        }
        batch += 1;
        if batch == READ_BATCH {
            batch = 0;
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests;
