use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Arc;

use tokio::sync::mpsc;
use tracing::warn;

use super::file_append::append_lines;
use super::state::{AcceptedAppend, PendingWriteCompletion};

runner_test_support!(network; #[cfg(test)]
use super::WriteGate;);

const DEFAULT_WRITER_SHARDS: usize = 4;
const DEFAULT_SHARD_QUEUE_CAPACITY: usize = 1024;
const DEFAULT_MAX_BATCH_ROWS: usize = 256;
pub(super) const DEFAULT_MAX_BATCH_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy)]
pub(super) struct WriterConfig {
    pub(super) shards: usize,
    pub(super) queue_capacity: usize,
    pub(super) max_batch_rows: usize,
    pub(super) max_batch_bytes: usize,
}

impl Default for WriterConfig {
    fn default() -> Self {
        Self {
            shards: DEFAULT_WRITER_SHARDS,
            queue_capacity: DEFAULT_SHARD_QUEUE_CAPACITY,
            max_batch_rows: DEFAULT_MAX_BATCH_ROWS,
            max_batch_bytes: DEFAULT_MAX_BATCH_BYTES,
        }
    }
}

pub(super) struct WriterPool {
    shards: Vec<mpsc::Sender<AcceptedAppend>>,
    #[cfg(test)]
    #[allow(dead_code)]
    pub(super) tasks: Vec<tokio::task::AbortHandle>,
}

struct PathWriteBatch {
    path: Arc<Path>,
    lines: Vec<String>,
    completions: Vec<PendingWriteCompletion>,
}

impl WriterConfig {
    pub(super) fn normalized(self) -> Self {
        Self {
            shards: self.shards.max(1),
            queue_capacity: self.queue_capacity.max(1),
            max_batch_rows: self.max_batch_rows.max(1),
            max_batch_bytes: self.max_batch_bytes.max(1),
        }
    }
}

impl WriterPool {
    pub(super) fn start(config: WriterConfig, #[cfg(test)] write_gate: Option<WriteGate>) -> Self {
        let mut shards = Vec::with_capacity(config.shards);
        #[cfg(test)]
        let mut tasks = Vec::with_capacity(config.shards);
        for _ in 0..config.shards {
            let (tx, rx) = mpsc::channel(config.queue_capacity);
            shards.push(tx);
            let task = tokio::spawn(run_writer_shard(
                rx,
                config,
                #[cfg(test)]
                write_gate.clone(),
            ));
            #[cfg(test)]
            tasks.push(task.abort_handle());
            // Channel closure owns normal shard completion; accepted-write
            // guards own accounting even if the shard unwinds or is cancelled.
            drop(task);
        }
        Self {
            shards,
            #[cfg(test)]
            tasks,
        }
    }

    pub(super) fn sender_for_path(&self, path: &Path) -> Option<mpsc::Sender<AcceptedAppend>> {
        let shard_count = self.shards.len();
        if shard_count == 0 {
            return None;
        }
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        let index = (hasher.finish() as usize) % shard_count;
        self.shards.get(index).cloned()
    }
}

async fn run_writer_shard(
    mut rx: mpsc::Receiver<AcceptedAppend>,
    config: WriterConfig,
    #[cfg(test)] write_gate: Option<WriteGate>,
) {
    let mut next_item = None;
    loop {
        let first = match next_item.take() {
            Some(item) => item,
            None => match rx.recv().await {
                Some(item) => item,
                None => return,
            },
        };
        let mut batches = Vec::new();
        let mut row_count = 0;
        let mut byte_count = 0;
        push_accepted_append(&mut batches, first, &mut row_count, &mut byte_count);

        while row_count < config.max_batch_rows {
            let item = match rx.try_recv() {
                Ok(item) => item,
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => break,
            };
            let item_bytes = item.line_len();
            if byte_count > 0 && byte_count + item_bytes > config.max_batch_bytes {
                next_item = Some(item);
                break;
            }
            push_accepted_append(&mut batches, item, &mut row_count, &mut byte_count);
        }

        for batch in batches {
            write_path_batch(
                batch,
                #[cfg(test)]
                write_gate.clone(),
            )
            .await;
        }
    }
}

fn push_accepted_append(
    batches: &mut Vec<PathWriteBatch>,
    item: AcceptedAppend,
    row_count: &mut usize,
    byte_count: &mut usize,
) {
    *row_count += 1;
    *byte_count += item.line_len();
    let (path, line, completion) = item.into_parts();
    if let Some(batch) = batches.iter_mut().find(|batch| batch.path == path) {
        batch.lines.push(line);
        batch.completions.push(completion);
    } else {
        batches.push(PathWriteBatch {
            path,
            lines: vec![line],
            completions: vec![completion],
        });
    }
}

async fn write_path_batch(batch: PathWriteBatch, #[cfg(test)] write_gate: Option<WriteGate>) {
    #[cfg(test)]
    if let Some(gate) = &write_gate
        && !gate.blocking
    {
        gate.started.notify_one();
        let permit = gate.release.acquire().await.expect("write gate closed");
        permit.forget();
    }

    let path = batch.path;
    let write_path = Arc::clone(&path);
    let result = tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        if let Some(gate) = write_gate
            && gate.blocking
        {
            gate.started.notify_one();
            tokio::runtime::Handle::current()
                .block_on(gate.release.acquire())
                .expect("blocking write gate closed")
                .forget();
        }
        let result = append_lines(write_path.as_ref(), &batch.lines);
        if let Err(error) = &result {
            warn!(path = %write_path.display(), %error, "failed to write network log");
        }
        // This closure can outlive the async shard. Settle only after physical
        // I/O completes; unwinding also drops the owned completion guards.
        PendingWriteCompletion::complete_batch(batch.completions, result.is_ok());
        result
    })
    .await;

    match result {
        Ok(Ok(())) => {}
        Ok(Err(_)) => {}
        Err(e) => {
            warn!(path = %path.display(), error = %e, "network log writer task failed");
        }
    }
}
