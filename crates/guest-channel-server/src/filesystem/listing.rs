use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};

use api_contracts::generated::{constants::sandbox_channel as limits, types::sandbox_channel::fs};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;

use super::{Scope, linux, reading};
use crate::{Error, Params};

const BUFFER_BYTES: usize = 16 * 1024;
const IDLE: Duration = Duration::from_millis(limits::fs::CURSOR_IDLE_MS as u64);

pub(super) struct State {
    root: File,
    pub(super) cursors: HashMap<String, Cursor>,
    pub(super) readers: reading::State,
}

pub(super) struct Cursor {
    directory: File,
    path: Vec<u8>,
    stamps: Vec<linux::Stamp>,
    buffer: Vec<u8>,
    offset: usize,
    filled: usize,
    pending: Option<fs::ListResultEntrie>,
    pub(super) idle_until: Instant,
}

enum Next {
    Entry(fs::ListResultEntrie),
    Eof,
    Budget,
}

impl State {
    pub(super) fn capture(path: &Path, scope: &mut Scope<'_>) -> Result<Self, Error> {
        Ok(Self {
            root: linux::capture(path, scope)?,
            cursors: HashMap::new(),
            readers: reading::State::default(),
        })
    }

    pub(super) fn expire(&mut self, now: Instant) {
        self.cursors.retain(|_, cursor| now < cursor.idle_until);
        self.readers.expire(now);
    }

    pub(super) fn execute(
        &mut self,
        params: &Params,
        scope: &mut Scope<'_>,
    ) -> Result<Value, Error> {
        self.expire(Instant::now());
        match params {
            Params::FsList(params) => self.list(params, scope),
            Params::FsListClose(params) => {
                self.cursors
                    .remove(&params.cursor)
                    .ok_or(Error::CursorExpired)?;
                Ok(serde_json::json!({}))
            }
            _ => self.readers.execute(&self.root, params, scope),
        }
    }

    fn list(&mut self, params: &fs::ListParams, scope: &mut Scope<'_>) -> Result<Value, Error> {
        let (id, mut cursor) = match (&params.path, &params.cursor) {
            (Some(tokens), None) => {
                if self.cursors.len() >= limits::fs::MAX_CURSORS as usize {
                    return Err(Error::Busy);
                }
                let path = linux::path(tokens)?;
                let (directory, stamps) = linux::resolve(&self.root, &path, scope)?;
                (
                    handle()?,
                    Cursor {
                        directory,
                        path,
                        stamps,
                        buffer: vec![0; BUFFER_BYTES],
                        offset: 0,
                        filled: 0,
                        pending: None,
                        idle_until: Instant::now() + IDLE,
                    },
                )
            }
            (None, Some(id)) => (
                id.clone(),
                self.cursors.remove(id).ok_or(Error::CursorExpired)?,
            ),
            _ => return Err(crate::ChannelError::InvalidParams.into()),
        };
        // Any failure disposes this listing rather than exposing stale rows or
        // retrying against a different directory under the same cursor identity.
        cursor.validate(&self.root, scope)?;
        let mut result = fs::ListResult {
            listing_id: id.clone(),
            entries: Vec::new(),
            next_cursor: Some(id.clone()),
        };
        let reserved = 2 * cursor.stamps.len() + 1;
        let mut eof = false;
        while result.entries.len() < limits::fs::MAX_ENTRIES as usize
            && scope.can_enumerate(reserved)
        {
            let entry = match cursor.next(scope, reserved)? {
                Next::Entry(entry) => entry,
                Next::Eof => {
                    eof = true;
                    break;
                }
                Next::Budget => break,
            };
            result.entries.push(entry);
            if !fits(&result)? {
                cursor.pending = result.entries.pop();
                if result.entries.is_empty() {
                    return Err(Error::Unavailable);
                }
                break;
            }
        }
        cursor.validate(&self.root, scope)?;
        if eof {
            result.next_cursor = None;
        }
        let value = serde_json::to_value(&result).map_err(|_| Error::Unavailable)?;
        if !eof {
            cursor.idle_until = Instant::now() + IDLE;
            self.cursors.insert(id, cursor);
        }
        Ok(value)
    }
}

impl Cursor {
    fn validate(&self, root: &File, scope: &mut Scope<'_>) -> Result<(), Error> {
        let (_, current) = linux::resolve(root, &self.path, scope).map_err(|error| {
            if matches!(error, Error::Unavailable | Error::TimedOut) {
                error
            } else {
                Error::DirectoryChanged
            }
        })?;
        if current != self.stamps
            || linux::stamp(&self.directory, scope)?
                != *self.stamps.last().ok_or(Error::Unavailable)?
        {
            return Err(Error::DirectoryChanged);
        }
        Ok(())
    }

    fn next(&mut self, scope: &mut Scope<'_>, reserved: usize) -> Result<Next, Error> {
        if let Some(entry) = self.pending.take() {
            return Ok(Next::Entry(entry));
        }
        loop {
            if !scope.can_enumerate(reserved) {
                return Ok(Next::Budget);
            }
            if self.offset == self.filled {
                self.filled = linux::read(&self.directory, &mut self.buffer, scope)?;
                self.offset = 0;
                if self.filled == 0 {
                    return Ok(Next::Eof);
                }
            }
            scope.step()?;
            // getdents64's name starts at byte 19 and its record length is the
            // native-endian u16 at byte 16. Parse without unaligned struct casts.
            let remaining = self
                .buffer
                .get(self.offset..self.filled)
                .ok_or(Error::Unavailable)?;
            let length = remaining.get(16..18).ok_or(Error::Unavailable)?;
            let length = usize::from(u16::from_ne_bytes(
                length.try_into().map_err(|_| Error::Unavailable)?,
            ));
            if length < 20 || length > remaining.len() {
                return Err(Error::Unavailable);
            }
            let raw = remaining.get(19..length).ok_or(Error::Unavailable)?;
            let end = raw
                .iter()
                .position(|byte| *byte == 0)
                .ok_or(Error::Unavailable)?;
            let name = raw.get(..end).ok_or(Error::Unavailable)?;
            self.offset += length;
            if name == b"." || name == b".." {
                continue;
            }
            if name.is_empty()
                || name.len() > limits::fs::MAX_NAME_BYTES as usize
                || name.contains(&b'/')
            {
                return Err(Error::Unavailable);
            }
            let kind = linux::kind(&self.directory, name, scope)?;
            return Ok(Next::Entry(fs::ListResultEntrie {
                name_token: URL_SAFE_NO_PAD.encode(name),
                display_name: linux::display(name)?,
                kind,
            }));
        }
    }
}

pub(super) fn handle() -> Result<String, Error> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|_| Error::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn fits(result: &fs::ListResult) -> Result<bool, Error> {
    struct Count(usize);
    impl Write for Count {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0 += buffer.len();
            Ok(buffer.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut count = Count(limits::RESPONSE_OVERHEAD_BYTES as usize);
    // The canonical reserve includes schema/type and both 36-byte UUID fields.
    // Count actual JSON escaping, names and continuation without allocating an
    // unbounded response; the peer independently validates the complete result.
    serde_json::to_writer(&mut count, result).map_err(|_| Error::Unavailable)?;
    Ok(count.0 <= limits::fs::MAX_RESPONSE_BYTES as usize)
}
