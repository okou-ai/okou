//! Withhold an untrusted map length before the public SDK can allocate it.

use super::evidence::{Detail, Stage, Status, Trace};
use serde::Deserialize;
use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, ReadBuf};

const MAX_MAP_BYTES: usize = 1024 * 1024;

pub(super) struct MapReader<R> {
    inner: R,
    header: [u8; 4],
    captured: usize,
    released: usize,
    body: Vec<u8>,
    filled: usize,
    emitted: usize,
    validated: bool,
    rejected: bool,
    trace: Trace,
}

impl<R> MapReader<R> {
    pub(super) fn new(inner: R) -> Self {
        let trace = Trace::current();
        trace.set(Stage::MapHeader, Status::Running, Detail::NotExposed);
        Self {
            inner,
            header: [0; 4],
            captured: 0,
            released: 0,
            body: Vec::new(),
            filled: 0,
            emitted: 0,
            validated: false,
            rejected: false,
            trace,
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for MapReader<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if out.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if this.rejected {
            return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
        }
        loop {
            while this.captured < 4 {
                let bytes = this
                    .header
                    .get_mut(this.captured..)
                    .ok_or(io::ErrorKind::InvalidData)?;
                let mut capture = ReadBuf::new(bytes);
                match Pin::new(&mut this.inner).poll_read(cx, &mut capture) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(error)) => {
                        this.trace.set(Stage::MapHeader, Status::Failed, Detail::Io);
                        return Poll::Ready(Err(error));
                    }
                    Poll::Ready(Ok(())) if capture.filled().is_empty() => {
                        this.trace.set(
                            Stage::MapHeader,
                            Status::Failed,
                            if this.captured == 0 {
                                Detail::EndOfStream
                            } else {
                                Detail::Truncated
                            },
                        );
                        return Poll::Ready(Ok(()));
                    }
                    Poll::Ready(Ok(())) => {
                        if this.captured == 0 {
                            this.trace.forget(&[
                                Stage::MapBody,
                                Stage::MapValidation,
                                Stage::MapDecode,
                            ]);
                        }
                        this.captured += capture.filled().len();
                    }
                }
                if this.captured == 4 {
                    let length = u32::from_le_bytes(this.header) as usize;
                    if length == 0 || length > MAX_MAP_BYTES {
                        this.trace
                            .set(Stage::MapHeader, Status::Failed, Detail::Limit);
                        this.rejected = true;
                        // SDK read_u32_le cannot complete, so PacketMut cannot allocate this length.
                        return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
                    }
                    this.body.resize(length, 0);
                    this.trace
                        .set(Stage::MapHeader, Status::Passed, Detail::NotExposed);
                    this.trace
                        .set(Stage::MapBody, Status::Running, Detail::NotExposed);
                }
            }
            // Validate key presence before SDK defaults can manufacture a
            // random public key for a peer whose wire metadata omitted it.
            // The SDK still owns all control decoding and typed field semantics.
            while this.filled < this.body.len() {
                let bytes = this
                    .body
                    .get_mut(this.filled..)
                    .ok_or(io::ErrorKind::InvalidData)?;
                let mut capture = ReadBuf::new(bytes);
                match Pin::new(&mut this.inner).poll_read(cx, &mut capture) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Err(error)) => {
                        this.trace.set(Stage::MapBody, Status::Failed, Detail::Io);
                        return Poll::Ready(Err(error));
                    }
                    Poll::Ready(Ok(())) if capture.filled().is_empty() => {
                        this.trace
                            .set(Stage::MapBody, Status::Failed, Detail::Truncated);
                        this.rejected = true;
                        return Poll::Ready(Err(io::ErrorKind::UnexpectedEof.into()));
                    }
                    Poll::Ready(Ok(())) => this.filled += capture.filled().len(),
                }
            }
            if !this.validated {
                this.trace
                    .set(Stage::MapBody, Status::Passed, Detail::NotExposed);
                if serde_json::from_slice::<RequiredKeys<'_>>(&this.body).map_or(true, |keys| {
                    keys.peers.as_ref().is_some_and(|peers| peers.len() > 256)
                        || keys.changed.as_ref().is_some_and(|peers| peers.len() > 256)
                        || keys
                            .derp
                            .as_ref()
                            .is_some_and(|map| !super::region_map::valid(map))
                }) {
                    this.trace
                        .set(Stage::MapValidation, Status::Failed, Detail::Invalid);
                    this.rejected = true;
                    return Poll::Ready(Err(io::ErrorKind::InvalidData.into()));
                }
                this.validated = true;
                this.trace
                    .set(Stage::MapValidation, Status::Passed, Detail::NotExposed);
                this.trace
                    .set(Stage::MapDecode, Status::Running, Detail::NotExposed);
            }
            if this.released < 4 {
                let count = out.remaining().min(4 - this.released);
                out.put_slice(
                    this.header
                        .get(this.released..this.released + count)
                        .ok_or(io::ErrorKind::InvalidData)?,
                );
                this.released += count;
                return Poll::Ready(Ok(()));
            }
            if this.emitted < this.body.len() {
                let count = out.remaining().min(this.body.len() - this.emitted);
                out.put_slice(
                    this.body
                        .get(this.emitted..this.emitted + count)
                        .ok_or(io::ErrorKind::InvalidData)?,
                );
                this.emitted += count;
                return Poll::Ready(Ok(()));
            }
            this.captured = 0;
            this.released = 0;
            this.body.clear();
            this.filled = 0;
            this.emitted = 0;
            this.validated = false;
            this.trace
                .set(Stage::MapHeader, Status::Running, Detail::NotExposed);
        }
    }
}

// Presence-only validation of public SDK input. Values are skipped without
// retaining a second node inventory; the public SDK performs actual decoding.
#[derive(Deserialize)]
struct PresentKey {
    #[serde(rename = "Key")]
    _key: serde::de::IgnoredAny,
}

#[derive(Deserialize)]
struct RequiredKeys<'a> {
    #[serde(rename = "Node")]
    _node: Option<PresentKey>,
    #[serde(rename = "Peers")]
    peers: Option<Vec<PresentKey>>,
    #[serde(rename = "PeersChanged")]
    changed: Option<Vec<PresentKey>>,
    #[serde(rename = "DERPMap", borrow)]
    derp: Option<ts_control_serde::DerpMap<'a>>,
}
