//! Retain only an admissible trimmed record while scanning the unchanged source
//! budget. A line's discarded content and whitespace do not need a full buffer.
//! This bounds input retention, not the decoded JSON tree or aggregate Host RSS.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum LineContent<'a> {
    Value(&'a str),
    Oversized(usize),
    InvalidUtf8,
}

pub(super) struct BoundedLogLine {
    content: String,
    max_bytes: usize,
    observed_bytes: usize,
    trimmed_bytes: usize,
    partial: [u8; 4],
    partial_len: usize,
    invalid_utf8: bool,
    terminated: bool,
}

impl BoundedLogLine {
    pub(super) fn new(max_bytes: usize) -> Self {
        Self {
            content: String::new(),
            max_bytes,
            observed_bytes: 0,
            trimmed_bytes: 0,
            partial: [0; 4],
            partial_len: 0,
            invalid_utf8: false,
            terminated: false,
        }
    }

    pub(super) async fn read<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> io::Result<usize> {
        self.content.clear();
        self.observed_bytes = 0;
        self.trimmed_bytes = 0;
        self.partial_len = 0;
        self.invalid_utf8 = false;
        self.terminated = false;
        let mut source_bytes = 0;
        loop {
            let input = reader.fill_buf().await?;
            if input.is_empty() {
                break;
            }
            let newline = input.iter().position(|byte| *byte == b'\n');
            let content_bytes = newline.unwrap_or(input.len());
            self.push(input.get(..content_bytes).ok_or_else(invalid_line_state)?)?;
            let consumed = content_bytes + usize::from(newline.is_some());
            reader.consume(consumed);
            source_bytes += consumed;
            if newline.is_some() {
                self.terminated = true;
                break;
            }
        }
        self.invalid_utf8 |= self.partial_len != 0;
        if self.trimmed_bytes <= self.max_bytes {
            self.content.truncate(self.trimmed_bytes);
        }
        Ok(source_bytes)
    }

    pub(super) fn terminated(&self) -> bool {
        self.terminated
    }

    pub(super) fn content(&self) -> LineContent<'_> {
        if self.invalid_utf8 {
            LineContent::InvalidUtf8
        } else if self.trimmed_bytes > self.max_bytes {
            LineContent::Oversized(self.trimmed_bytes)
        } else {
            LineContent::Value(&self.content)
        }
    }

    fn push(&mut self, mut input: &[u8]) -> io::Result<()> {
        if self.invalid_utf8 {
            return Ok(());
        }
        if self.partial_len != 0 {
            // Only an incomplete, otherwise valid UTF-8 sequence is retained.
            let width = self.partial[0].leading_ones() as usize;
            let consumed = width
                .checked_sub(self.partial_len)
                .ok_or_else(invalid_line_state)?
                .min(input.len());
            let (prefix, remaining) = input
                .split_at_checked(consumed)
                .ok_or_else(invalid_line_state)?;
            self.partial
                .get_mut(self.partial_len..self.partial_len + consumed)
                .ok_or_else(invalid_line_state)?
                .copy_from_slice(prefix);
            self.partial_len += consumed;
            input = remaining;
            if self.partial_len < width {
                return Ok(());
            }
            let character =
                std::str::from_utf8(self.partial.get(..width).ok_or_else(invalid_line_state)?)
                    .ok()
                    .and_then(|value| value.chars().next());
            let Some(character) = character else {
                self.invalid_utf8 = true;
                return Ok(());
            };
            let mut encoded = [0; 4];
            self.push_str(character.encode_utf8(&mut encoded))?;
            self.partial_len = 0;
        }
        match std::str::from_utf8(input) {
            Ok(value) => self.push_str(value)?,
            Err(error) => {
                let (valid, tail) = input
                    .split_at_checked(error.valid_up_to())
                    .ok_or_else(invalid_line_state)?;
                self.push_str(std::str::from_utf8(valid).map_err(|_| invalid_line_state())?)?;
                if error.error_len().is_some() {
                    self.invalid_utf8 = true;
                } else {
                    self.partial
                        .get_mut(..tail.len())
                        .ok_or_else(invalid_line_state)?
                        .copy_from_slice(tail);
                    self.partial_len = tail.len();
                }
            }
        }
        Ok(())
    }

    fn push_str(&mut self, mut value: &str) -> io::Result<()> {
        if self.observed_bytes == 0 {
            value = value.trim_start();
        }
        let before = self.observed_bytes;
        self.observed_bytes += value.len();
        let trimmed = value.trim_end();
        if !trimmed.is_empty() {
            self.trimmed_bytes = before + trimmed.len();
        }
        // Copy validated chunks in bulk. A cap inside a UTF-8 character must
        // not retain a partial character, including discarded trailing spaces.
        let mut end = value.len().min(self.max_bytes.saturating_sub(before));
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        let required = self.content.len() + end;
        if required > self.content.capacity() {
            let capacity = required
                .max(self.content.capacity().max(8).saturating_mul(2))
                .min(self.max_bytes);
            self.content.reserve_exact(capacity - self.content.len());
        }
        self.content
            .push_str(value.get(..end).ok_or_else(invalid_line_state)?);
        Ok(())
    }
}

fn invalid_line_state() -> io::Error {
    io::Error::other("invalid bounded network log line state")
}

#[cfg(test)]
mod tests;
