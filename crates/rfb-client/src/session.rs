//! Caller-driven session ownership. No background workers or request queue.

use std::{future::Future, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    time::Instant,
};
use uuid::Uuid;

use crate::{
    Capture, Error, FramebufferConnection, Input, InputOutcome, capture, framebuffer::bounded,
    input, memory::Budget,
};

/// Identifies the coordinate space of one session. Frame updates without a
/// DesktopSize change retain this identity; a new connection never reuses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub session_id: Uuid,
    pub epoch: u64,
}

/// Serialized RFB capture and input. The caller owns the idle lifetime timer and
/// must close/drop this object at expires_at(), lease expiry or Run cancellation.
/// An idle object performs no IO and cannot detect disconnect or resize itself.
/// Dropping a polled operation closes its stream and leaves this session closed.
pub struct Session<S> {
    connection: Option<FramebufferConnection<S>>,
    id: Uuid,
    expires_at: Instant,
    budget: Budget,
}

impl<S> Session<S> {
    /// Adopt an initialized authenticated decoder with a maximum two-hour
    /// operation lifetime. Run/lease owners may close it earlier.
    pub fn new(connection: FramebufferConnection<S>) -> Self {
        let budget = connection.budget.clone();
        Self {
            connection: Some(connection),
            id: Uuid::new_v4(),
            expires_at: Instant::now() + Duration::from_secs(2 * 60 * 60),
            budget,
        }
    }

    /// Last observed geometry. Remote changes become visible at the next refresh.
    pub fn geometry(&self) -> Option<Geometry> {
        self.connection.as_ref().map(|connection| Geometry {
            session_id: self.id,
            epoch: connection.geometry_epoch(),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.connection.is_none()
    }

    /// Deadline the outer owner must drive even while this session is idle.
    pub fn expires_at(&self) -> Instant {
        self.expires_at
    }

    /// Includes captures retained by callers, even after this session closes.
    pub fn memory_usage(&self) -> (usize, usize) {
        self.budget.usage()
    }

    /// Immediately drop the owned transport. There are no tasks to detach/join.
    /// A lost connection cannot guarantee the remote side received key releases.
    pub fn close(&mut self) {
        self.connection = None;
    }

    fn deadline(&mut self, caller: Instant, cap: Duration) -> Result<Instant, Error> {
        if self.is_closed() {
            return Err(Error::SessionClosed);
        }
        let deadline = caller.min(self.expires_at).min(Instant::now() + cap);
        if deadline <= Instant::now() {
            self.close();
            return Err(Error::DeadlineExceeded);
        }
        Ok(deadline)
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> Session<S> {
    /// Request a fresh complete image and encode an immutable bounded PNG.
    /// The PNG excludes the cursor; its shape is returned separately. A fresh
    /// RFB response does not prove that a remote application has settled.
    pub async fn capture(&mut self, deadline: Instant) -> Result<Capture, Error> {
        let deadline = self.deadline(deadline, Duration::from_secs(30))?;
        let connection = self.connection.take().ok_or(Error::SessionClosed)?;
        let id = self.id;
        let (connection, capture) = bounded(deadline, async move {
            let connection = refresh(connection, deadline).await?;
            let geometry = Geometry {
                session_id: id,
                epoch: connection.geometry_epoch(),
            };
            let capture = capture::encode(&connection, geometry).await?;
            Ok((connection, capture))
        })
        .await?;
        self.connection = Some(connection);
        Ok(capture)
    }

    /// Prevalidate a complete balanced input operation, then send it once.
    /// A caller-owned outcome remains observable after cancellation: Unknown
    /// means an input write was attempted; Sent means all writes and flush
    /// completed, not that an application accepted them. Never replay Unknown.
    /// Coordinate inputs refresh before checking the supplied geometry; RFB
    /// cannot make that check atomic with a later server-side resize.
    /// The outcome resets at future creation, even if it is never polled; such
    /// cancellation leaves the untouched session open and input NotStarted.
    pub fn input<'a>(
        &'a mut self,
        command: Input<'a>,
        outcome: &'a mut InputOutcome,
        deadline: Instant,
    ) -> impl Future<Output = Result<(), Error>> + 'a {
        *outcome = InputOutcome::NotStarted;
        self.send_input(command, outcome, deadline)
    }

    async fn send_input(
        &mut self,
        command: Input<'_>,
        outcome: &mut InputOutcome,
        deadline: Instant,
    ) -> Result<(), Error> {
        let deadline = self.deadline(deadline, Duration::from_secs(5))?;
        let sequence = input::compile(command, &self.budget)?;
        let connection = self.connection.as_ref().ok_or(Error::SessionClosed)?;
        sequence.validate_geometry(
            Geometry {
                session_id: self.id,
                epoch: connection.geometry_epoch(),
            },
            connection.width(),
            connection.height(),
        )?;
        let mut connection = self.connection.take().ok_or(Error::SessionClosed)?;
        let id = self.id;
        let connection = bounded(deadline, async {
            if sequence.geometry.is_some() {
                connection = refresh(connection, deadline).await?;
                sequence.validate_geometry(
                    Geometry {
                        session_id: id,
                        epoch: connection.geometry_epoch(),
                    },
                    connection.width(),
                    connection.height(),
                )?;
            }
            for message in sequence.messages() {
                if deadline <= Instant::now() {
                    return Err(Error::DeadlineExceeded);
                }
                // write_all may accept a prefix before yielding or failing.
                *outcome = InputOutcome::Unknown;
                connection.stream.write_all(message).await?;
                tokio::task::yield_now().await;
            }
            connection.stream.flush().await?;
            Ok(connection)
        })
        .await?;
        self.connection = Some(connection);
        *outcome = InputOutcome::Sent;
        Ok(())
    }
}

async fn refresh<S: AsyncRead + AsyncWrite + Unpin + 'static>(
    mut connection: FramebufferConnection<S>,
    deadline: Instant,
) -> Result<FramebufferConnection<S>, Error> {
    let mut incremental = false;
    for _ in 0..64 {
        connection = connection.update(incremental, deadline).await?;
        // TigerVNC clears its outstanding request after resize-only replies.
        // Even complete pixels after DesktopSize require the next full request.
        if !connection.needs_full_update() && connection.pixels().is_some() {
            return Ok(connection);
        }
        incremental = !connection.needs_full_update();
    }
    Err(Error::ResourceLimit)
}
