//! Fixed-target internal forwarding over the existing Run-owned SSH authority.

use std::{
    io,
    net::IpAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use russh::client;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{FailureReason, Run, Scope, invalidates_access, observation, pool};

const SETUP_TIMEOUT: Duration = Duration::from_secs(60);

/// One direct-tcpip channel and the exclusive physical SSH transport carrying it.
///
/// Field order is deliberate: normal drop closes the logical channel before the
/// pool lease retires the physical connection.
pub(crate) struct DirectTcpIpStream {
    stream: russh::ChannelStream<client::Msg>,
    monitor_done: CancellationToken,
    lease: Option<pool::Lease>,
}

impl DirectTcpIpStream {
    fn retire(&mut self) {
        drop(self.lease.take());
    }
}

impl Drop for DirectTcpIpStream {
    fn drop(&mut self) {
        self.monitor_done.cancel();
    }
}

impl AsyncRead for DirectTcpIpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let can_read = buffer.remaining() > 0;
        let result = Pin::new(&mut self.stream).poll_read(cx, buffer);
        if matches!(&result, Poll::Ready(Err(_)))
            || (can_read
                && matches!(&result, Poll::Ready(Ok(())))
                && buffer.filled().len() == before)
        {
            self.retire();
        }
        result
    }
}

impl AsyncWrite for DirectTcpIpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, bytes);
        if matches!(&result, Poll::Ready(Err(_)))
            || (!bytes.is_empty() && matches!(&result, Poll::Ready(Ok(0))))
        {
            self.retire();
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.stream).poll_flush(cx);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.retire();
        }
        result
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.stream).poll_shutdown(cx);
        if matches!(&result, Poll::Ready(_)) {
            self.retire();
        }
        result
    }
}

impl Run {
    pub(crate) async fn open_direct_tcpip(
        &self,
        connection: Uuid,
        expected_generation: i64,
        host: &str,
        port: u16,
        cancelled: CancellationToken,
        deadline: Instant,
    ) -> Result<DirectTcpIpStream, FailureReason> {
        validate_target(host, port)?;
        let operation = Arc::new(
            Arc::clone(&self.sessions.forwarding)
                .try_acquire_owned()
                .map_err(|_| FailureReason::ResourceExhausted)?,
        );
        let caller_cancelled = cancelled.clone();
        let scope = Scope {
            cancelled: self.sessions.cancel.child_token(),
            sandbox_cancelled: cancelled,
            deadline: deadline.min(Instant::now() + SETUP_TIMEOUT),
        };
        scope.check()?;
        let access = self.sessions.registration.lookup(connection)?;
        let mut attempt = observation::Attempt::default();
        let result = async {
            let credential = scope
                .wait(access.prepare(self.runtime.prepare(
                    Arc::clone(&operation),
                    self.sessions.run,
                    connection,
                    &scope,
                    &mut attempt,
                )))
                .await??;
            let generation = credential
                .trust
                .lock()
                .map_err(|_| FailureReason::Protocol)?
                .generation;
            attempt.generation = Some(generation);
            if generation != expected_generation {
                return Err(FailureReason::ConfigurationChanged);
            }
            attempt.connecting = true;
            let lease = self
                .sessions
                .pool
                .acquire(
                    &self.runtime,
                    pool::Request {
                        connection,
                        credential,
                        access: access.clone(),
                        operation,
                    },
                    &scope,
                    &mut attempt,
                )
                .await?;
            let stream = lease
                .connected()
                .open_direct_tcpip(host, port, &scope)
                .await?;
            let transport_cancelled = lease.cancelled();
            let monitor_done = CancellationToken::new();
            let task_done = monitor_done.clone();
            let task_transport = transport_cancelled.clone();
            self.sessions.tasks.spawn(async move {
                tokio::select! { biased;
                    () = task_done.cancelled() => (),
                    () = task_transport.cancelled() => (),
                    () = caller_cancelled.cancelled() => task_transport.cancel(),
                }
            });
            Ok(DirectTcpIpStream {
                stream,
                monitor_done,
                lease: Some(lease),
            })
        }
        .await;
        if result
            .as_ref()
            .is_err_and(|failure| invalidates_access(*failure))
        {
            access.invalidate();
        }
        self.report(connection, &attempt, result.as_ref().err().copied());
        result
    }

    fn report(
        &self,
        connection: Uuid,
        attempt: &observation::Attempt,
        failure: Option<FailureReason>,
    ) {
        let Some(observation) = attempt.finish(failure) else {
            return;
        };
        let Ok(permit) = Arc::clone(&self.runtime.reports).try_acquire_owned() else {
            tracing::info!(run_id = %self.sessions.run, connection_id = %connection, "SSH observation report capacity exhausted");
            return;
        };
        let authority = Arc::clone(&self.runtime.authority);
        let run = self.sessions.run;
        self.sessions.tasks.spawn(async move {
            let _permit = permit;
            authority.observe(run, connection, observation).await;
        });
    }
}

fn validate_target(host: &str, port: u16) -> Result<(), FailureReason> {
    if port == 0 || host.is_empty() || host.len() > 253 || !host.is_ascii() {
        return Err(FailureReason::UnsafeDestination);
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if host == ip.to_string() {
            Ok(())
        } else {
            Err(FailureReason::UnsafeDestination)
        };
    }
    if runner_types::firewall_hostname_policy::is_ipv4_literal_like(host.trim_end_matches('.'))
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return Err(FailureReason::UnsafeDestination);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_requires_canonical_unambiguous_host_and_nonzero_port() {
        for host in [
            "desktop.internal",
            "LOCALHOST",
            "127.0.0.1",
            "10.0.0.1",
            "2001:db8::1",
            "::1",
        ] {
            assert_eq!(validate_target(host, 5900), Ok(()), "accepted: {host}");
        }
        for host in [
            "",
            "desktop.internal.",
            "127.1",
            "2130706433",
            "0x7f000001",
            "127.000.000.001",
            "2001:0db8::1",
            "[2001:db8::1]",
            "fe80::1%eth0",
            "https://desktop.internal",
            "user@desktop.internal",
            "desktop.internal:5900",
            "desktop.internal/path",
            "desktop\\internal",
            "desktop..internal",
            "-desktop.internal",
            "desktop-.internal",
            "desktop.internal ",
            "d\u{e9}sktop.internal",
        ] {
            assert_eq!(
                validate_target(host, 5900),
                Err(FailureReason::UnsafeDestination),
                "rejected: {host}"
            );
        }
        assert_eq!(
            validate_target("desktop.internal", 0),
            Err(FailureReason::UnsafeDestination)
        );
        assert_eq!(
            validate_target(&format!("{}.internal", "a".repeat(244)), 5900),
            Err(FailureReason::UnsafeDestination)
        );
    }
}
