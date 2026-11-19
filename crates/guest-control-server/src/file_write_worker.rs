use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, TrySendError};
use std::thread;

use guest_control_proto::{FileWriteStage, FileWriteStatus};

use crate::file_write_progress::{FileWriteProgress, FileWriteRequestProgress};

use crate::handlers::{
    decode_write_file_message, decode_write_files_message, handle_decoded_write_file_message,
    handle_decoded_write_files_message,
};
use crate::log::log;
use crate::quiesce::OperationGuard;
use crate::worker_ownership::{
    ConnectionWorkerState, ShutdownConnectionOnDrop, SingleActiveAdmission, SingleActivePermit,
};
use crate::writer::GuestWriter;

const THREAD_FILE_WRITE: &str = "gctl-file-write";

#[derive(Clone, Copy)]
pub(crate) enum FileWriteKind {
    File,
    Files,
    PrivateFiles,
}

impl FileWriteKind {
    pub(crate) const fn operation_label(self) -> &'static str {
        match self {
            Self::File => "write_file",
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
            Self::Files | Self::PrivateFiles => decode_write_files_message(payload).map(|_| ()),
        }
    }
}

pub(crate) enum FileWriteSubmitError {
    Busy,
    Disconnected,
}

pub(crate) enum FileWritePayload {
    Buffered {
        kind: FileWriteKind,
        bytes: Vec<u8>,
    },
    #[cfg(target_os = "linux")]
    Sealed {
        input: std::fs::File,
        stats: crate::handlers::WriteFilesStats,
    },
}

struct FileWriteRequest {
    seq: u32,
    payload: FileWritePayload,
    operation_guard: OperationGuard,
    admission: SingleActivePermit,
    progress: FileWriteRequestProgress,
}

pub(crate) struct FileWriteWorker {
    state: Option<ConnectionWorkerState<FileWriteRequest>>,
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
        let worker_cancel = Arc::clone(&connection_cancel);
        let handle = thread::Builder::new()
            .name(THREAD_FILE_WRITE.to_string())
            .spawn(move || {
                // This worker exists for exactly one connection. Any exit,
                // including an unwind, closes that connection so a pending
                // host request cannot wait without a response producer.
                let _shutdown_on_exit = ShutdownConnectionOnDrop::new(writer.clone());
                while let Ok(request) = receiver.recv() {
                    if let Err(error) = handle_request(request, &writer, &worker_cancel) {
                        log("ERROR", &format!("file-write worker failed: {error}"));
                        break;
                    }
                }
            })?;

        Ok(Self {
            state: Some(ConnectionWorkerState::new(sender, handle)),
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
        seq: u32,
        payload: FileWritePayload,
        operation_guard: OperationGuard,
        admission: SingleActivePermit,
    ) -> Result<(), FileWriteSubmitError> {
        let request = FileWriteRequest {
            seq,
            payload,
            operation_guard,
            admission,
            progress: self.progress.start(seq),
        };
        let Some(state) = &self.state else {
            return Err(FileWriteSubmitError::Disconnected);
        };
        match state.sender().try_send(request) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(FileWriteSubmitError::Busy),
            Err(TrySendError::Disconnected(_)) => Err(FileWriteSubmitError::Disconnected),
        }
    }
}

impl Drop for FileWriteWorker {
    fn drop(&mut self) {
        // Signal first so an active helper's cancellable wait kills and reaps
        // its process group before this connection-owned worker is joined.
        self.connection_cancel.store(true, Ordering::Release);
        if let Some(state) = self.state.take()
            && state.close_and_join().is_err()
        {
            log("ERROR", "file-write worker panicked");
        }
    }
}

fn handle_request(
    request: FileWriteRequest,
    writer: &GuestWriter,
    connection_cancel: &AtomicBool,
) -> io::Result<()> {
    let FileWriteRequest {
        seq,
        payload,
        operation_guard,
        admission,
        progress,
    } = request;

    // Finish with the input before releasing admission at the response writer.
    let response = match payload {
        FileWritePayload::Buffered { kind, bytes } => match kind {
            FileWriteKind::File => decode_write_file_message(&bytes)
                .map_err(protocol_error)
                .and_then(|decoded| {
                    handle_decoded_write_file_message(seq, decoded, connection_cancel, &progress)
                }),
            FileWriteKind::Files | FileWriteKind::PrivateFiles => {
                decode_write_files_message(&bytes)
                    .map_err(protocol_error)
                    .and_then(|decoded| {
                        handle_decoded_write_files_message(
                            seq,
                            decoded,
                            matches!(kind, FileWriteKind::PrivateFiles),
                            connection_cancel,
                            &progress,
                        )
                    })
            }
        },
        #[cfg(target_os = "linux")]
        FileWritePayload::Sealed { input, stats } => {
            crate::handlers::handle_sealed_write_files_message(
                seq,
                input,
                stats,
                connection_cancel,
                &progress,
            )
        }
    };
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
