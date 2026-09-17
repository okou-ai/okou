//! Bounded request-scoped zstd streaming. File selection belongs to the caller.
use std::future::Future;
use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crate::connection::FrameWriteDecision;
use crate::{FrameWriteObserver, Shared};
use guest_control_proto::{
    BorrowedRawMessage, MSG_WRITE_FILE_STREAM_BEGIN, MSG_WRITE_FILE_STREAM_CREDIT,
    MSG_WRITE_FILE_STREAM_DATA, MSG_WRITE_FILE_STREAM_END, RawMessage,
};
use tokio::sync::{mpsc, oneshot};

const BLOCK: usize = 64 * 1024;
const WINDOW: usize = 4;

#[derive(Default)]
pub(crate) struct State {
    credits: Mutex<Option<(u32, mpsc::Sender<u8>)>>,
}

pub(crate) fn dispatch_credit(
    shared: &Arc<Shared>,
    msg: BorrowedRawMessage<'_>,
) -> io::Result<bool> {
    if msg.msg_type != MSG_WRITE_FILE_STREAM_CREDIT {
        return Ok(false);
    }
    let [count] = msg.payload else {
        return Err(io::Error::other("invalid file stream credit"));
    };
    if *count == 0 || usize::from(*count) > WINDOW {
        return Err(io::Error::other("invalid file stream credit"));
    }
    let route = shared
        .file_stream
        .credits
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let Some((seq, sender)) = route.as_ref() else {
        return Ok(true); // Discard late credit after an abandoned transfer.
    };
    if *seq != msg.seq {
        return Err(io::Error::other("file stream credit sequence mismatch"));
    }
    sender
        .try_send(*count)
        .map_err(|_| io::Error::other("file stream credit overflow"))?;
    Ok(true)
}

struct Begin {
    payload: Vec<u8>,
    sequence: oneshot::Sender<u32>,
    credit: mpsc::Sender<u8>,
}

pub(crate) struct Transfer {
    shared: Arc<Shared>,
    begin: Option<Begin>,
    sequence: Option<oneshot::Receiver<u32>>,
    credit: mpsc::Receiver<u8>,
    raw: Option<Vec<u8>>,
    started: Arc<AtomicBool>,
    terminal: bool,
}

impl Transfer {
    pub(crate) fn new(shared: Arc<Shared>, raw: &[u8], metadata: Vec<u8>) -> io::Result<Self> {
        // Codec tag 1 identifies one checksummed zstd frame.
        let mut payload = vec![1];
        payload.extend_from_slice(
            &u32::try_from(raw.len())
                .map_err(io::Error::other)?
                .to_be_bytes(),
        );
        payload.extend_from_slice(&metadata);
        let (sequence_tx, sequence_rx) = oneshot::channel();
        let (credit_tx, credit_rx) = mpsc::channel(WINDOW + 1);
        Ok(Self {
            shared,
            begin: Some(Begin {
                payload,
                sequence: sequence_tx,
                credit: credit_tx,
            }),
            sequence: Some(sequence_rx),
            credit: credit_rx,
            raw: Some(raw.to_vec()),
            started: Arc::new(AtomicBool::new(false)),
            terminal: false,
        })
    }

    pub(crate) fn observer(&self, original: FrameWriteObserver) -> FrameWriteObserver {
        let started = Arc::clone(&self.started);
        FrameWriteObserver::new(move || {
            original.record_write_start()?;
            started.store(true, Ordering::Release);
            Ok(())
        })
    }

    pub(crate) fn take_builder(
        &mut self,
    ) -> io::Result<impl FnOnce(u32, &mut Vec<u8>) -> io::Result<()> + use<>> {
        let begin = self
            .begin
            .take()
            .ok_or_else(|| io::Error::other("stream already submitted"))?;
        let shared = Arc::clone(&self.shared);
        Ok(move |seq, frame: &mut Vec<u8>| {
            *shared
                .file_stream
                .credits
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some((seq, begin.credit));
            *frame = guest_control_proto::encode(MSG_WRITE_FILE_STREAM_BEGIN, seq, &begin.payload)
                .map_err(io::Error::other)?;
            begin
                .sequence
                .send(seq)
                .map_err(|_| io::Error::other("stream owner gone"))
        })
    }

    pub(crate) async fn run(
        &mut self,
        terminal: impl Future<Output = io::Result<RawMessage>>,
    ) -> io::Result<RawMessage> {
        tokio::pin!(terminal);
        let result = tokio::select! {
            result = &mut terminal => result,
            sent = self.send() => {
                sent?;
                terminal.await
            }
        };
        self.terminal = result.is_ok();
        result
    }

    async fn send(&mut self) -> io::Result<()> {
        let seq = self
            .sequence
            .take()
            .ok_or_else(|| io::Error::other("stream already sent"))?
            .await
            .map_err(io::Error::other)?;
        // Guest admission precedes codec work.
        let mut credits = self.next_credit().await?;
        let raw = self
            .raw
            .take()
            .ok_or_else(|| io::Error::other("stream input already consumed"))?;
        let mut producer = Producer::start(raw)?;
        while let Some(bytes) = producer.next().await {
            if credits == 0 {
                credits = self.next_credit().await?;
            }
            credits -= 1;
            let frame = guest_control_proto::encode(MSG_WRITE_FILE_STREAM_DATA, seq, &bytes)
                .map_err(io::Error::other)?;
            self.shared
                .write_frame(&frame, || Ok(FrameWriteDecision::Write), |_, _| {})
                .await?;
        }
        producer.finish()?;
        let frame = guest_control_proto::encode(MSG_WRITE_FILE_STREAM_END, seq, &[])
            .map_err(io::Error::other)?;
        self.shared
            .write_frame(&frame, || Ok(FrameWriteDecision::Write), |_, _| {})
            .await?;
        Ok(())
    }

    async fn next_credit(&mut self) -> io::Result<usize> {
        self.credit
            .recv()
            .await
            .map(usize::from)
            .ok_or_else(|| io::Error::other("file stream credit closed"))
    }
}

impl Drop for Transfer {
    fn drop(&mut self) {
        self.shared
            .file_stream
            .credits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if !self.terminal && self.started.load(Ordering::Acquire) {
            self.shared.poison_connection();
        }
    }
}

struct Producer {
    receiver: Option<mpsc::Receiver<Vec<u8>>>,
    handle: Option<JoinHandle<io::Result<()>>>,
    cancel: Arc<AtomicBool>,
}

impl Producer {
    fn start(raw: Vec<u8>) -> io::Result<Self> {
        let (tx, rx) = mpsc::channel(WINDOW);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = Arc::clone(&cancel);
        let handle = std::thread::Builder::new()
            .name("gctl-file-codec".into())
            .spawn(move || {
                let sink = io::BufWriter::with_capacity(BLOCK, ChunkWriter(tx));
                let mut encoder = zstd::stream::write::Encoder::new(sink, -1)?;
                encoder.include_checksum(true)?;
                encoder.set_pledged_src_size(Some(raw.len() as u64))?;
                for bytes in raw.chunks(BLOCK) {
                    if worker_cancel.load(Ordering::Acquire) {
                        return Err(io::Error::other("file codec cancelled"));
                    }
                    encoder.write_all(bytes)?;
                }
                encoder.finish()?.flush()
            })?;
        Ok(Self {
            receiver: Some(rx),
            handle: Some(handle),
            cancel,
        })
    }

    async fn next(&mut self) -> Option<Vec<u8>> {
        self.receiver.as_mut()?.recv().await
    }

    fn finish(&mut self) -> io::Result<()> {
        self.receiver.take();
        self.handle
            .take()
            .ok_or_else(|| io::Error::other("file codec already joined"))?
            .join()
            .map_err(|_| io::Error::other("file codec panicked"))?
    }
}

impl Drop for Producer {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        // Close the bounded sink before joining, including future cancellation.
        self.receiver.take();
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct ChunkWriter(mpsc::Sender<Vec<u8>>);

impl Write for ChunkWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let chunk = bytes
            .get(..bytes.len().min(BLOCK))
            .ok_or_else(|| io::Error::other("invalid codec chunk"))?;
        self.0
            .blocking_send(chunk.to_vec())
            .map_err(|_| io::Error::other("file codec cancelled"))?;
        Ok(chunk.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
