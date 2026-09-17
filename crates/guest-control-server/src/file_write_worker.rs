use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};

use guest_control_proto::{FileWriteStage, FileWriteStatus};

use crate::file_write_progress::{FileWriteProgress, FileWriteRequestProgress};

use crate::handlers::{
    decode_write_file_message, decode_write_files_message, handle_decoded_write_file_message,
    handle_decoded_write_files_message,
};
use crate::log::log;
use crate::quiesce::OperationGuard;
use crate::worker_ownership::{
    ShutdownConnectionOnDrop, SingleActiveAdmission, SingleActivePermit,
};
use crate::writer::GuestWriter;

const THREAD_FILE_WRITE: &str = "gctl-file-write";

#[derive(Clone, Copy)]
pub(crate) enum FileWriteKind {
    File,
    Stream,
    Files,
    PrivateFiles,
}

impl FileWriteKind {
    pub(crate) const fn operation_label(self) -> &'static str {
        match self {
            Self::File => "write_file",
            Self::Stream => "file_stream",
            Self::Files => "write_files",
            Self::PrivateFiles => "write_private_files",
        }
    }

    pub(crate) fn validate_payload(
        self,
        payload: &[u8],
    ) -> Result<(), guest_control_proto::ProtocolError> {
        match self {
            Self::File => decode_write_file_message(payload).map(|_| ()),
            Self::Stream => crate::file_stream::validate_begin(payload),
            Self::Files | Self::PrivateFiles => decode_write_files_message(payload).map(|_| ()),
        }
    }
}

pub(crate) enum FileWriteSubmitError {
    Busy,
    Disconnected,
}

struct FileWriteRequest {
    stream: Option<crate::file_stream::Input>,
    kind: FileWriteKind,
    seq: u32,
    payload: Vec<u8>,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
    progress: FileWriteRequestProgress,
}

pub(crate) struct FileWriteWorker {
    streams: Arc<crate::file_stream::Streams>,
    writer: GuestWriter,
    sender: Option<SyncSender<FileWriteRequest>>,
    handle: Option<JoinHandle<()>>,
    admission: SingleActiveAdmission,
    connection_cancel: Arc<AtomicBool>,
    progress: FileWriteProgress,
}

impl FileWriteWorker {
    pub(crate) fn start(
        writer: GuestWriter,
        connection_cancel: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        // The atomic admission permit bounds active plus queued work to one.
        // The channel still has capacity so the decoder can use try_send and
        // can never wait for the worker to call recv.
        let (sender, receiver) = mpsc::sync_channel(1);
        let streams = Arc::new(crate::file_stream::Streams::default());
        let worker_streams = Arc::clone(&streams);
        let public_writer = writer.clone();
        let worker_cancel = Arc::clone(&connection_cancel);
        let handle = thread::Builder::new()
            .name(THREAD_FILE_WRITE.to_string())
            .spawn(move || {
                // This worker exists for exactly one connection. Any exit,
                // including an unwind, closes that connection so a pending
                // host request cannot wait without a response producer.
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) =
                        handle_request(request, &writer, &worker_cancel, &worker_streams)
                    {
                        log("ERROR", &format!("file-write worker failed: {error}"));
                        break;
                    }
                }
            })?;

        Ok(Self {
            streams,
            writer: public_writer,
            sender: Some(sender),
            handle: Some(handle),
            admission: SingleActiveAdmission::new(),
            connection_cancel,
            progress: FileWriteProgress::default(),
        })
    }

    pub(crate) fn try_admit(&self) -> Option<SingleActivePermit> {
        self.admission.try_acquire()
    }

    pub(crate) fn status(&self) -> FileWriteStatus {
        self.progress.snapshot()
    }

    pub(crate) fn submit(
        &self,
        kind: FileWriteKind,
        seq: u32,
        payload: &[u8],
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), FileWriteSubmitError> {
        let stream = if matches!(kind, FileWriteKind::Stream) {
            Some(
                self.streams
                    .begin(
                        seq,
                        self.writer.clone(),
                        Arc::clone(&self.connection_cancel),
                    )
                    .map_err(|_| FileWriteSubmitError::Disconnected)?,
            )
        } else {
            None
        };
        let request = FileWriteRequest {
            stream,
            kind,
            seq,
            payload: payload.to_vec(),
            operation_guard,
            admission,
            progress: self.progress.start(seq),
        };
        let Some(sender) = &self.sender else {
            return Err(FileWriteSubmitError::Disconnected);
        };
        match sender.try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(FileWriteSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => Err(FileWriteSubmitError::Disconnected),
        }
    }

    pub(crate) fn stream_data(
        &self,
        msg: guest_control_proto::BorrowedRawMessage<'_>,
    ) -> io::Result<()> {
        self.streams.accept(msg)
    }
}

impl Drop for FileWriteWorker {
    fn drop(&mut self) {
        // Signal first so an active helper's cancellable wait kills and reaps
        // its process group before this connection-owned worker is joined.
        self.connection_cancel.store(true, Ordering::Release);
        drop(self.sender.take());
        if let Some(handle) = self.handle.take()
            && handle.join().is_err()
        {
            log("ERROR", "file-write worker panicked");
        }
    }
}

fn handle_request(
    request: FileWriteRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
    streams: &crate::file_stream::Streams,
) -> io::Result<()> {
    let FileWriteRequest {
        stream,
        kind,
        seq,
        payload,
        operation_guard,
        admission,
        progress,
    } = request;

    let response = match kind {
        FileWriteKind::Stream => crate::handlers::handle_file_stream(
            seq,
            &payload,
            stream.ok_or_else(|| io::Error::other("missing file stream input"))?,
            connection_cancel,
            &progress,
        ),
        FileWriteKind::File => decode_write_file_message(&payload)
            .map_err(protocol_error)
            .and_then(|decoded| {
                handle_decoded_write_file_message(seq, decoded, connection_cancel, &progress)
            }),
        FileWriteKind::Files => decode_write_files_message(&payload)
            .map_err(protocol_error)
            .and_then(|decoded| {
                handle_decoded_write_files_message(
                    seq,
                    decoded,
                    false,
                    connection_cancel,
                    &progress,
                )
            }),
        FileWriteKind::PrivateFiles => decode_write_files_message(&payload)
            .map_err(protocol_error)
            .and_then(|decoded| {
                handle_decoded_write_files_message(seq, decoded, true, connection_cancel, &progress)
            }),
    };
    // Admission may be released at the writer boundary, but do not retain the
    // completed request's large payload while the result frame is being sent.
    drop(payload);
    streams.finish(seq);
    progress.mark(FileWriteStage::WaitingForWriter);

    match response {
        Ok(response) => writer
            .write_frame_after_lock_unless_cancelled(&response, connection_cancel, || {
                progress.mark(FileWriteStage::WritingResponse);
                operation_guard.release();
                drop(admission);
            })
            .map(|sent| {
                if sent {
                    progress.mark(FileWriteStage::ResponseSent);
                }
            }),
        Err(error) => {
            writer.shutdown_after_lock(|| {
                operation_guard.release();
                drop(admission);
            });
            Err(error)
        }
    }
}

fn protocol_error(error: guest_control_proto::ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error.to_string())
}
