use std::{future::Future, path::Path, time::Duration};

use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use tokio::io::AsyncReadExt;

use super::{R2Error, R2ImageCache, archive::pack_template_to_writer, io_other};

/// Multipart part size. R2 minimum is 5 MiB (except last part); 16 MiB
/// keeps part count reasonable for large images and fits comfortably in memory.
const PART_SIZE: usize = 16 * 1024 * 1024;

/// The SDK response timeout includes sending the body. Allow slow 16 MiB
/// uploads without leaving the final response wait unbounded.
const UPLOAD_PART_RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);

impl R2ImageCache {
    pub(super) async fn do_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        template: &Path,
    ) -> Result<(), R2Error> {
        let parts = self.stream_upload(key, upload_id, template).await?;
        self.client
            .complete_multipart_upload()
            .bucket(&self.bucket)
            .key(key)
            .upload_id(upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(parts))
                    .build(),
            )
            .send()
            .await?;
        Ok(())
    }

    /// Stream-pack one template and upload it as multipart parts.
    async fn stream_upload(
        &self,
        key: &str,
        upload_id: &str,
        template: &Path,
    ) -> Result<Vec<CompletedPart>, R2Error> {
        // Duplex buffer ≈ 2× PART_SIZE so the producer can stay one part ahead
        // of the consumer without backpressure stalls.
        let (writer, reader) = tokio::io::duplex(PART_SIZE * 2);
        let template_owned = template.to_path_buf();

        // Producer: pack tar.zst into the duplex writer end, then drop everything
        // (which closes the writer, signalling EOF to the consumer).
        let pack_handle = tokio::task::spawn_blocking(move || -> Result<(), R2Error> {
            let sync_writer = tokio_util::io::SyncIoBridge::new(writer);
            pack_template_to_writer(sync_writer, &template_owned)
        });

        // Consumer: stream PART_SIZE chunks to S3 multipart with bounded
        // concurrency. If this errors, dropping `reader` closes the duplex pipe
        // and the producer will get a BrokenPipe write error.
        let parts_result = self.upload_parts_streaming(key, upload_id, reader).await;

        // Always wait for the producer to drain. A producer error matters even
        // if the consumer "succeeded" — it means parts contain truncated data.
        let pack_result = pack_handle.await.map_err(|e| R2Error::Io(io_other(e)))?;

        // Error precedence: consumer error wins (it's the original cause; pack's
        // BrokenPipe is downstream noise). If consumer succeeded but pack errored,
        // surface the pack error so the caller skips Complete.
        match (parts_result, pack_result) {
            (Err(consumer_err), _) => Err(consumer_err),
            (Ok(_), Err(pack_err)) => Err(pack_err),
            (Ok(parts), Ok(())) => Ok(parts),
        }
    }

    async fn upload_parts_streaming(
        &self,
        key: &str,
        upload_id: &str,
        reader: tokio::io::DuplexStream,
    ) -> Result<Vec<CompletedPart>, R2Error> {
        // Bounded concurrency: 4 in-flight parts gives ~75% reduction in wall
        // time vs serial without saturating the bucket's per-prefix throughput.
        const CONCURRENCY: usize = 4;

        let client = self.client.clone();
        let part_timeouts = client
            .config()
            .timeout_config()
            .map(TimeoutConfig::to_builder)
            .unwrap_or_else(TimeoutConfig::builder)
            .read_timeout(UPLOAD_PART_RESPONSE_TIMEOUT)
            .build();
        let bucket = self.bucket.clone();
        let key_owned = key.to_string();
        let upload_id_owned = upload_id.to_string();

        upload_parts_streaming_with(reader, PART_SIZE, CONCURRENCY, move |pn, chunk| {
            let client = client.clone();
            let part_timeouts = part_timeouts.clone();
            let bucket = bucket.clone();
            let key_owned = key_owned.clone();
            let upload_id_owned = upload_id_owned.clone();
            async move {
                let resp = client
                    .upload_part()
                    .bucket(&bucket)
                    .key(&key_owned)
                    .upload_id(&upload_id_owned)
                    .part_number(pn)
                    .body(ByteStream::from(chunk))
                    .customize()
                    .config_override(
                        aws_sdk_s3::config::Builder::new().timeout_config(part_timeouts),
                    )
                    .send()
                    .await?;
                // S3 / R2 always return ETag for a successful upload_part.
                // A missing ETag here would silently produce a CompletedPart
                // that fails Complete with "InvalidPart"; surface a clearer
                // error pinned to the offending part_number instead.
                let e_tag = resp
                    .e_tag()
                    .ok_or_else(|| {
                        R2Error::S3(format!("upload_part {pn}: missing e_tag in response"))
                    })?
                    .to_string();
                Ok(CompletedPart::builder()
                    .e_tag(e_tag)
                    .part_number(pn)
                    .build())
            }
        })
        .await
    }
}

async fn upload_parts_streaming_with<R, Upload, UploadFuture>(
    mut reader: R,
    part_size: usize,
    concurrency: usize,
    upload: Upload,
) -> Result<Vec<CompletedPart>, R2Error>
where
    R: tokio::io::AsyncRead + Unpin,
    Upload: Fn(i32, bytes::Bytes) -> UploadFuture + Clone + Send + Sync + 'static,
    UploadFuture: Future<Output = Result<CompletedPart, R2Error>> + Send + 'static,
{
    assert!(part_size > 0, "multipart part_size must be non-zero");
    assert!(concurrency > 0, "multipart concurrency must be non-zero");

    let mut tasks: tokio::task::JoinSet<Result<(i32, CompletedPart), R2Error>> =
        tokio::task::JoinSet::new();
    let mut parts: Vec<(i32, CompletedPart)> = Vec::new();
    let mut part_number: i32 = 1;
    let mut eof = false;

    while !eof || !tasks.is_empty() {
        // Refill the in-flight window by reading and spawning more parts.
        while !eof && tasks.len() < concurrency {
            let mut buf = vec![0u8; part_size];
            let n = read_full(&mut reader, &mut buf).await?;
            if n == 0 {
                eof = true;
                break;
            }
            buf.truncate(n);
            // Vec → Bytes is zero-copy (transfers ownership). Avoids the
            // ~16 MiB memcpy per part that `to_vec()` would do.
            let chunk = bytes::Bytes::from(buf);
            let pn = part_number;
            let upload_part = upload.clone();
            tasks.spawn(async move { upload_part(pn, chunk).await.map(|part| (pn, part)) });
            part_number = part_number
                .checked_add(1)
                .ok_or_else(|| R2Error::Io(io_other("part_number overflow")))?;
            if n < part_size {
                eof = true;
                break;
            }
        }

        // Drain at least one completion. JoinSet returns None only when
        // empty, which our outer loop condition prevents.
        if let Some(joined) = tasks.join_next().await {
            let result = match joined {
                Ok(result) => result,
                Err(error) => Err(R2Error::Io(io_other(error))),
            };
            match result {
                Ok((pn, part)) => parts.push((pn, part)),
                Err(error) => {
                    // Finish cancelling uploads before the caller aborts the multipart session.
                    tasks.shutdown().await;
                    return Err(error);
                }
            }
        }
    }

    // Parts must be in part_number order for CompleteMultipartUpload.
    parts.sort_by_key(|(pn, _)| *pn);
    Ok(parts.into_iter().map(|(_, p)| p).collect())
}

pub(super) struct MultipartUploadGuard {
    client: aws_sdk_s3::Client,
    bucket: String,
    key: String,
    upload_id: String,
    runtime: tokio::runtime::Handle,
    armed: bool,
}

impl MultipartUploadGuard {
    pub(super) fn new(
        client: aws_sdk_s3::Client,
        bucket: String,
        key: String,
        upload_id: String,
    ) -> Self {
        Self {
            client,
            bucket,
            key,
            upload_id,
            runtime: tokio::runtime::Handle::current(),
            armed: true,
        }
    }

    pub(super) fn upload_id(&self) -> &str {
        &self.upload_id
    }

    pub(super) fn disarm(&mut self) {
        self.armed = false;
    }

    pub(super) async fn abort(&mut self) {
        if !self.armed {
            return;
        }
        abort_multipart_upload(
            self.client.clone(),
            self.bucket.clone(),
            self.key.clone(),
            self.upload_id.clone(),
            "failed multipart upload",
        )
        .await;
        self.disarm();
    }
}

impl Drop for MultipartUploadGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }

        drop(self.runtime.spawn(abort_multipart_upload(
            self.client.clone(),
            self.bucket.clone(),
            self.key.clone(),
            self.upload_id.clone(),
            "cancelled multipart upload",
        )));
    }
}

async fn abort_multipart_upload(
    client: aws_sdk_s3::Client,
    bucket: String,
    key: String,
    upload_id: String,
    reason: &'static str,
) {
    if let Err(e) = client
        .abort_multipart_upload()
        .bucket(bucket)
        .key(&key)
        .upload_id(&upload_id)
        .send()
        .await
    {
        tracing::warn!(
            error = %e,
            key,
            upload_id,
            reason,
            "failed to abort R2 multipart upload"
        );
    }
}

/// Read up to `buf.len()` bytes from `reader`, returning the actual count.
/// Returns 0 only at true EOF. Generic over any `AsyncRead` so we can use it
/// for both `tokio::fs::File` and `tokio::io::DuplexStream`.
async fn read_full<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    buf: &mut [u8],
) -> Result<usize, R2Error> {
    let mut total = 0;
    while total < buf.len() {
        let slice = buf
            .get_mut(total..)
            .ok_or_else(|| R2Error::Io(io_other("buf overrun")))?;
        let n = reader.read(slice).await?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n)
            .ok_or_else(|| R2Error::Io(io_other("read offset overflow")))?;
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Cursor},
        pin::Pin,
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        task::{Context, Poll},
        time::Duration,
    };

    use tokio::{
        io::{AsyncRead, ReadBuf},
        sync::{Barrier, Notify, mpsc},
    };

    use super::*;

    // Turn early admission of the queued third part into a synchronous failure,
    // so the absence assertion does not depend on executor timing.
    struct WindowGuardReader {
        inner: Cursor<Vec<u8>>,
        blocked_at: u64,
        queued_read_allowed: Arc<AtomicBool>,
    }

    impl AsyncRead for WindowGuardReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if self.inner.position() >= self.blocked_at
                && !self.queued_read_allowed.load(Ordering::SeqCst)
            {
                return Poll::Ready(Err(io::Error::other(
                    "multipart scheduler read a queued part before an upload slot was released",
                )));
            }

            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    #[tokio::test]
    async fn multipart_scheduler_bounds_concurrency_and_returns_parts_ordered() {
        let queued_read_allowed = Arc::new(AtomicBool::new(false));
        let reader = WindowGuardReader {
            inner: Cursor::new(b"aaaabbbbcccc".to_vec()),
            blocked_at: 8,
            queued_read_allowed: Arc::clone(&queued_read_allowed),
        };
        let releases = Arc::new([
            Arc::new(Notify::new()),
            Arc::new(Notify::new()),
            Arc::new(Notify::new()),
        ]);
        let in_flight = Arc::new(AtomicUsize::new(0));
        let peak_in_flight = Arc::new(AtomicUsize::new(0));
        let (started_tx, mut started_rx) = mpsc::unbounded_channel();
        let (completed_tx, mut completed_rx) = mpsc::unbounded_channel();

        let upload = {
            let releases = Arc::clone(&releases);
            let in_flight = Arc::clone(&in_flight);
            let peak_in_flight = Arc::clone(&peak_in_flight);
            move |part_number: i32, chunk: bytes::Bytes| {
                let releases = Arc::clone(&releases);
                let in_flight = Arc::clone(&in_flight);
                let peak_in_flight = Arc::clone(&peak_in_flight);
                let started_tx = started_tx.clone();
                let completed_tx = completed_tx.clone();
                async move {
                    let (expected_chunk, release_index): (&[u8], usize) = match part_number {
                        1 => (b"aaaa", 0),
                        2 => (b"bbbb", 1),
                        3 => (b"cccc", 2),
                        _ => panic!("unexpected part_number {part_number}"),
                    };
                    assert_eq!(chunk.as_ref(), expected_chunk);

                    let active = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak_in_flight.fetch_max(active, Ordering::SeqCst);
                    started_tx.send(part_number).expect("send start event");

                    releases[release_index].notified().await;

                    let previous_active = in_flight.fetch_sub(1, Ordering::SeqCst);
                    assert!(previous_active > 0, "in-flight upload count underflow");
                    completed_tx
                        .send(part_number)
                        .expect("send completion event");

                    Ok(CompletedPart::builder()
                        .e_tag(format!("etag-{part_number}"))
                        .part_number(part_number)
                        .build())
                }
            }
        };

        let controller = async {
            let mut initial_parts = vec![
                started_rx.recv().await.expect("first upload should start"),
                started_rx.recv().await.expect("second upload should start"),
            ];
            initial_parts.sort_unstable();
            assert_eq!(initial_parts, vec![1, 2]);
            assert_eq!(in_flight.load(Ordering::SeqCst), 2);
            assert_eq!(peak_in_flight.load(Ordering::SeqCst), 2);
            assert!(matches!(
                started_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ));

            queued_read_allowed.store(true, Ordering::SeqCst);
            releases[1].notify_one();
            assert_eq!(completed_rx.recv().await, Some(2));
            assert_eq!(started_rx.recv().await, Some(3));
            assert_eq!(in_flight.load(Ordering::SeqCst), 2);
            assert_eq!(peak_in_flight.load(Ordering::SeqCst), 2);

            releases[2].notify_one();
            assert_eq!(completed_rx.recv().await, Some(3));
            releases[0].notify_one();
            assert_eq!(completed_rx.recv().await, Some(1));
            assert_eq!(in_flight.load(Ordering::SeqCst), 0);
            Ok::<(), R2Error>(())
        };
        let scheduler = upload_parts_streaming_with(reader, 4, 2, upload);

        let (parts, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::try_join!(scheduler, controller)
        })
        .await
        .expect("multipart scheduler test timed out")
        .expect("multipart scheduler failed");

        let completed_parts = parts
            .iter()
            .map(|part| {
                (
                    part.part_number().expect("part_number"),
                    part.e_tag().expect("e_tag").to_string(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            completed_parts,
            vec![
                (1, "etag-1".to_string()),
                (2, "etag-2".to_string()),
                (3, "etag-3".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn multipart_scheduler_drops_siblings_before_returning_terminal_errors() {
        #[derive(Clone, Copy)]
        enum Failure {
            Upload,
            Join,
        }

        struct DropFlag(Arc<AtomicBool>);

        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        for failure in [Failure::Upload, Failure::Join] {
            let reader = WindowGuardReader {
                inner: Cursor::new(b"aaaabbbbcccc".to_vec()),
                blocked_at: 8,
                queued_read_allowed: Arc::new(AtomicBool::new(false)),
            };
            let initial_uploads_ready = Arc::new(Barrier::new(2));
            let sibling_dropped = Arc::new(AtomicBool::new(false));

            let upload = {
                let initial_uploads_ready = Arc::clone(&initial_uploads_ready);
                let sibling_dropped = Arc::clone(&sibling_dropped);
                move |part_number: i32, chunk: bytes::Bytes| {
                    let initial_uploads_ready = Arc::clone(&initial_uploads_ready);
                    let sibling_dropped = Arc::clone(&sibling_dropped);
                    async move {
                        let expected_chunk: &[u8] = match part_number {
                            1 => b"aaaa",
                            2 => b"bbbb",
                            _ => panic!("unexpected part_number {part_number}"),
                        };
                        assert_eq!(chunk.as_ref(), expected_chunk);

                        let _drop_flag =
                            (part_number == 1).then(|| DropFlag(Arc::clone(&sibling_dropped)));
                        initial_uploads_ready.wait().await;

                        if part_number == 1 {
                            std::future::pending::<Result<CompletedPart, R2Error>>().await
                        } else {
                            match failure {
                                Failure::Upload => {
                                    Err(R2Error::S3("upload part 2 failed".to_string()))
                                }
                                Failure::Join => panic!("upload part 2 panicked"),
                            }
                        }
                    }
                }
            };

            let error = tokio::time::timeout(
                Duration::from_secs(5),
                upload_parts_streaming_with(reader, 4, 2, upload),
            )
            .await
            .expect("multipart scheduler test timed out")
            .expect_err("multipart scheduler should return the terminal error");

            assert!(
                sibling_dropped.load(Ordering::SeqCst),
                "sibling upload must be dropped before the scheduler returns"
            );
            match (failure, error) {
                (Failure::Upload, R2Error::S3(message)) => {
                    assert_eq!(message, "upload part 2 failed");
                }
                (Failure::Join, R2Error::Io(error)) => {
                    assert!(
                        error.to_string().contains("upload part 2 panicked"),
                        "join error must preserve the task panic: {error}"
                    );
                }
                (_, other) => panic!("unexpected scheduler error: {other:?}"),
            }
        }
    }
}
