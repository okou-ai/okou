use std::collections::VecDeque;

use base64::Engine;
use serde::Serialize;

use super::super::{FailureReason, output::Stream};

const CHUNK_BYTES: usize = 4096;
const CHUNKS: usize = 256;
const READ_BYTES: usize = 8192;
const READ_CHUNKS: usize = 32;

struct Retained {
    cursor: u64,
    stream: Stream,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub(super) struct Buffer {
    chunks: VecDeque<Retained>,
    pub(super) end: u64,
}

#[derive(Serialize)]
pub(super) struct Chunk {
    pub(super) cursor: u64,
    pub(super) stream: Stream,
    pub(super) data: String,
}

#[derive(Serialize)]
pub(super) struct Lost {
    from: u64,
    to: u64,
}

#[derive(Serialize)]
pub(super) struct Read {
    pub(super) chunks: Vec<Chunk>,
    pub(super) next_cursor: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) lost: Option<Lost>,
}

impl Buffer {
    pub(super) fn oldest(&self) -> u64 {
        self.chunks.front().map_or(self.end, |chunk| chunk.cursor)
    }

    pub(super) fn append(&mut self, stream: Stream, mut bytes: &[u8]) -> Result<(), FailureReason> {
        while !bytes.is_empty() {
            let next = self
                .chunks
                .back_mut()
                .filter(|chunk| chunk.stream == stream && chunk.bytes.len() < CHUNK_BYTES);
            let take = if let Some(chunk) = next {
                let take = bytes.len().min(CHUNK_BYTES - chunk.bytes.len());
                chunk
                    .bytes
                    .extend_from_slice(bytes.get(..take).ok_or(FailureReason::Protocol)?);
                take
            } else {
                let take = bytes.len().min(CHUNK_BYTES);
                self.chunks.push_back(Retained {
                    cursor: self.end,
                    stream,
                    bytes: bytes.get(..take).ok_or(FailureReason::Protocol)?.to_vec(),
                });
                take
            };
            self.end = self
                .end
                .checked_add(take as u64)
                .filter(|end| *end <= 9_007_199_254_740_991)
                .ok_or(FailureReason::Protocol)?;
            bytes = bytes.get(take..).ok_or(FailureReason::Protocol)?;
            if self.chunks.len() > CHUNKS {
                self.chunks.pop_front();
            }
        }
        Ok(())
    }

    pub(super) fn read(&self, requested: u64) -> Result<Read, FailureReason> {
        let mut cursor = requested.max(self.oldest());
        let lost = (requested < cursor).then_some(Lost {
            from: requested,
            to: cursor,
        });
        let mut remaining = READ_BYTES;
        let mut chunks = Vec::new();
        for chunk in &self.chunks {
            let end = chunk.cursor + chunk.bytes.len() as u64;
            if end <= cursor {
                continue;
            }
            let start = (cursor - chunk.cursor) as usize;
            let take = remaining.min(chunk.bytes.len() - start);
            chunks.push(Chunk {
                cursor,
                stream: chunk.stream,
                data: base64::engine::general_purpose::STANDARD.encode(
                    chunk
                        .bytes
                        .get(start..start + take)
                        .ok_or(FailureReason::Protocol)?,
                ),
            });
            cursor += take as u64;
            remaining -= take;
            if remaining == 0 || chunks.len() == READ_CHUNKS {
                break;
            }
        }
        Ok(Read {
            chunks,
            next_cursor: cursor,
            lost,
        })
    }
}
