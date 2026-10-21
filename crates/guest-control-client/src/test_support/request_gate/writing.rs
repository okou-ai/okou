use std::io;

use tokio::io::AsyncWriteExt;
use tokio::net::unix::OwnedWriteHalf;

use super::{Frame, ResponseDisposition};

pub(super) enum Kind {
    Forward,
    Request,
    Terminal(ResponseDisposition),
}

pub(super) struct Job {
    pub(super) frame: Frame,
    pub(super) kind: Kind,
    written: usize,
}

/// One bounded frame with persistent progress, independently polled per direction.
pub(super) struct Writer {
    stream: OwnedWriteHalf,
    job: Option<Job>,
}

impl Writer {
    pub(super) fn new(stream: OwnedWriteHalf) -> Self {
        Self { stream, job: None }
    }

    pub(super) fn is_idle(&self) -> bool {
        self.job.is_none()
    }

    pub(super) fn queue(&mut self, frame: Frame, kind: Kind) -> io::Result<()> {
        if self.job.is_some() {
            return Err(io::Error::other("Guest relay writer already owns a frame"));
        }
        self.job = Some(Job {
            frame,
            kind,
            written: 0,
        });
        Ok(())
    }

    pub(super) fn take(&mut self) -> Option<Job> {
        self.job.take()
    }

    pub(super) async fn flush(&mut self) -> io::Result<Job> {
        let job = self
            .job
            .as_mut()
            .ok_or_else(|| io::Error::other("Guest relay writer has no frame"))?;
        while job.written < job.frame.raw().len() {
            let bytes = job
                .frame
                .raw()
                .get(job.written..)
                .ok_or_else(|| io::Error::other("Guest relay write exceeded original frame"))?;
            let count = self.stream.write(bytes).await?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "Guest relay write made no progress",
                ));
            }
            job.written += count;
        }
        self.job
            .take()
            .ok_or_else(|| io::Error::other("Guest relay lost completed frame"))
    }

    pub(super) async fn shutdown(&mut self) -> io::Result<()> {
        self.stream.shutdown().await
    }
}
