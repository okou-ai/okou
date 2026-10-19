use std::{
    collections::HashMap,
    fs::File,
    os::unix::fs::FileExt,
    time::{Duration, Instant},
};

use api_contracts::generated::{
    constants::sandbox_channel::fs as limits, types::sandbox_channel::fs,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

use super::{Scope, linux, listing};
use crate::{ChannelError, Error, Params};

const IDLE: Duration = Duration::from_millis(limits::HANDLE_IDLE_MS as u64);

#[derive(Default)]
pub(super) struct State {
    pub(super) handles: HashMap<String, Reader>,
}

pub(super) struct Reader {
    file: File,
    path: Vec<u8>,
    ancestors: Vec<linux::Stamp>,
    stamp: linux::FileStamp,
    selected: u64,
    pub(super) idle_until: Instant,
}

impl State {
    pub(super) fn expire(&mut self, now: Instant) {
        self.handles.retain(|_, reader| now < reader.idle_until);
    }

    pub(super) fn execute(
        &mut self,
        root: &File,
        params: &Params,
        scope: &mut Scope<'_>,
    ) -> Result<Value, Error> {
        match params {
            Params::FsOpen(params) => self.open(root, params, scope),
            Params::FsRead(params) => {
                // Any failure retires this identity rather than retrying against
                // a new file or retaining a failed transfer's descriptor.
                let mut reader = self
                    .handles
                    .remove(&params.handle)
                    .ok_or(Error::HandleExpired)?;
                reader.validate(root, scope)?;
                let offset = params
                    .offset
                    .parse::<u64>()
                    .map_err(|_| ChannelError::InvalidParams)?;
                if offset > reader.selected
                    || params.length == 0
                    || params.length > u64::from(limits::MAX_CHUNK_BYTES)
                {
                    return Err(ChannelError::InvalidParams.into());
                }
                let length = params.length.min(reader.selected - offset);
                let mut bytes = vec![0; usize::try_from(length).map_err(|_| Error::Unavailable)?];
                let mut filled = 0;
                while filled < bytes.len() {
                    scope.step()?;
                    match reader.file.read_at(
                        bytes.get_mut(filled..).ok_or(Error::Unavailable)?,
                        offset + filled as u64,
                    ) {
                        Ok(0) => return Err(Error::FileChanged),
                        Ok(count) => filled += count,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => (),
                        Err(_) => return Err(Error::Unavailable),
                    }
                }
                #[cfg(test)]
                scope.hook(true);
                reader.validate(root, scope)?;
                scope.live()?;
                let value =
                    json!({"offset":params.offset,"length":length,"data":STANDARD.encode(bytes)});
                reader.idle_until = Instant::now() + IDLE;
                self.handles.insert(params.handle.clone(), reader);
                Ok(value)
            }
            Params::FsFinish(params) => {
                let reader = self
                    .handles
                    .remove(&params.handle)
                    .ok_or(Error::HandleExpired)?;
                reader.validate(root, scope)?;
                Ok(json!({}))
            }
            Params::FsClose(params) => {
                self.handles
                    .remove(&params.handle)
                    .ok_or(Error::HandleExpired)?;
                Ok(json!({}))
            }
            _ => Err(Error::Unavailable),
        }
    }

    fn open(
        &mut self,
        root: &File,
        params: &fs::OpenParams,
        scope: &mut Scope<'_>,
    ) -> Result<Value, Error> {
        if self.handles.len() >= limits::MAX_HANDLES as usize {
            return Err(Error::Busy);
        }
        let path = linux::path(&params.path)?;
        let (parent_path, name) = split(&path)?;
        let (parent, ancestors) = linux::resolve(root, parent_path, scope)?;
        let (pinned, stamp) = linux::pin_regular(&parent, name, scope)?;
        let selected = match params.mode {
            fs::OpenParamsMode::Download => stamp.size,
            fs::OpenParamsMode::Preview if stamp.size <= u64::from(limits::MAX_PREVIEW_BYTES) => {
                stamp.size
            }
            fs::OpenParamsMode::Preview => return Err(ChannelError::LimitExceeded.into()),
            fs::OpenParamsMode::Prefix => stamp.size.min(u64::from(limits::MAX_PREFIX_BYTES)),
        };
        let file = linux::readable(&pinned, stamp, scope)?;
        let display_name = linux::display(name)?;
        let reader = Reader {
            file,
            path,
            ancestors,
            stamp,
            selected,
            idle_until: Instant::now() + IDLE,
        };
        reader.validate(root, scope)?;
        let handle = listing::handle()?;
        let value = json!({
            "handle":handle,"nameToken":params.path.last().ok_or(ChannelError::InvalidParams)?,
            "displayName":display_name,"fileSize":stamp.size.to_string(),
            "selectedSize":selected.to_string(),"truncated":selected < stamp.size,
        });
        scope.live()?;
        self.handles.insert(handle, reader);
        Ok(value)
    }
}

impl Reader {
    fn validate(&self, root: &File, scope: &mut Scope<'_>) -> Result<(), Error> {
        let (parent_path, name) = split(&self.path)?;
        let (parent, ancestors) = linux::resolve(root, parent_path, scope).map_err(changed)?;
        if ancestors.len() != self.ancestors.len()
            || !ancestors
                .iter()
                .zip(&self.ancestors)
                .all(|(now, before)| now.same_identity(before))
        {
            return Err(Error::FileChanged);
        }
        let (_, current) = linux::pin_regular(&parent, name, scope).map_err(changed)?;
        if current != self.stamp || linux::file_stamp(&self.file, scope)? != self.stamp {
            return Err(Error::FileChanged);
        }
        scope.live()
    }
}

fn changed(error: Error) -> Error {
    match error {
        Error::Unavailable | Error::TimedOut => error,
        _ => Error::FileChanged,
    }
}

fn split(path: &[u8]) -> Result<(&[u8], &[u8]), Error> {
    if path.is_empty() {
        return Err(ChannelError::InvalidParams.into());
    }
    Ok(match path.iter().rposition(|b| *b == b'/') {
        Some(index) => (
            path.get(..index).ok_or(Error::Unavailable)?,
            path.get(index + 1..).ok_or(Error::Unavailable)?,
        ),
        None => (&[], path),
    })
}
