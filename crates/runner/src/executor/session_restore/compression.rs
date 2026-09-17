//! Session-history business policy; the file transport does not choose codecs.
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use sandbox::FileCompression;

use super::MaterializedResumeSession;
use crate::error::{RunnerError, RunnerResult};
use crate::telemetry::HistoryCodecReason;

const MIN_BYTES: usize = 16 * 1024 * 1024;
const SAMPLE_BYTES: usize = 64 * 1024;
const SAMPLE_COUNT: usize = 8;

pub(super) async fn select(
    session: &MaterializedResumeSession,
) -> RunnerResult<(FileCompression, HistoryCodecReason)> {
    let bytes = session.history_bytes();
    if session.codex_zstd_history().is_some() {
        return Ok((FileCompression::None, HistoryCodecReason::NativeZstd));
    }
    if bytes.len() < MIN_BYTES {
        return Ok((FileCompression::None, HistoryCodecReason::BelowThreshold));
    }

    // Copy only bounded samples, not the whole resident history, into owned work.
    let samples = (0..SAMPLE_COUNT)
        .map(|index| {
            let offset = (bytes.len() - SAMPLE_BYTES) * index / (SAMPLE_COUNT - 1);
            bytes
                .get(offset..offset + SAMPLE_BYTES)
                .map(<[u8]>::to_vec)
                .ok_or_else(|| io::Error::other("invalid history compression sample"))
        })
        .collect::<io::Result<Vec<_>>>()
        .map_err(selection_error)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let worker_cancel = Arc::clone(&cancel);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = std::thread::Builder::new()
        .name("history-codec-policy".into())
        .spawn(move || {
            let _ = sender.send(sample(samples, &worker_cancel));
        })
        .map_err(selection_error)?;
    let mut worker = SelectionWorker {
        handle: Some(handle),
        cancel,
    };
    let result = receiver.await.map_err(selection_error);
    worker.join().map_err(selection_error)?;
    let codec = result?.map_err(selection_error)?;
    let reason = match codec {
        FileCompression::None => HistoryCodecReason::SampleRejected,
        FileCompression::Zstd => HistoryCodecReason::SampleAccepted,
    };
    Ok((codec, reason))
}

fn sample(samples: Vec<Vec<u8>>, cancel: &AtomicBool) -> io::Result<FileCompression> {
    for raw in samples {
        if cancel.load(Ordering::Acquire) {
            return Err(io::Error::other("history compression selection cancelled"));
        }
        let encoded = zstd::bulk::compress(&raw, -1)?;
        // Each spread window must save at least half its bytes. This heuristic
        // rejects common low-benefit/mixed content, not every heterogeneous file.
        if encoded.len() > raw.len() / 2 {
            return Ok(FileCompression::None);
        }
    }
    Ok(FileCompression::Zstd)
}

fn selection_error(error: impl std::fmt::Display) -> RunnerError {
    RunnerError::Internal(format!("select history transfer compression: {error}"))
}

struct SelectionWorker {
    handle: Option<JoinHandle<()>>,
    cancel: Arc<AtomicBool>,
}

impl SelectionWorker {
    fn join(&mut self) -> io::Result<()> {
        if let Some(handle) = self.handle.take() {
            handle
                .join()
                .map_err(|_| io::Error::other("history compression selector panicked"))?;
        }
        Ok(())
    }
}

impl Drop for SelectionWorker {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        // No Guest operation has started, and at most one 64 KiB sample remains
        // between cancellation checkpoints. Never leave detached selector work.
        let _ = self.join();
    }
}
