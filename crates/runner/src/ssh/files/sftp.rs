//! Private sequential SFTP v3 subset. Validate lengths before allocating and
//! discard server diagnostics. A partially completed exchange cannot be reused.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::{
    codec::{Attrs, Fields, string},
    protocol::{Failure, FileFailure, PATH_BYTES},
};
use crate::ssh::FailureReason;

pub(super) const CHUNK: usize = 32 * 1024;
const PACKET: usize = 64 * 1024;
const HANDLE: usize = 256;

#[derive(Debug)]
pub(super) enum Error {
    Protocol,
    Transport,
    Status(u32),
}

impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::Transport
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        match error {
            Error::Protocol => FailureReason::Protocol.into(),
            Error::Transport => FailureReason::Disconnected.into(),
            Error::Status(2) => FileFailure::PathNotFound.into(),
            Error::Status(3) => FileFailure::PermissionDenied.into(),
            Error::Status(8) => FileFailure::UnsupportedOperation.into(),
            Error::Status(_) => FileFailure::FileOperationFailed.into(),
        }
    }
}

enum Reply {
    Status(u32),
    Handle(Vec<u8>),
    Data(Vec<u8>),
    Attrs(Attrs),
    Name(Vec<u8>),
}

pub(super) struct Client<S> {
    stream: S,
    id: u32,
    healthy: bool,
    pub(super) hardlink: bool,
    pub(super) rename: bool,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Client<S> {
    pub(super) async fn init(stream: S) -> Result<Self, Error> {
        let mut client = Self {
            stream,
            id: 0,
            healthy: false,
            hardlink: false,
            rename: false,
        };
        client.write(&[1, 0, 0, 0, 3]).await?;
        let bytes = client.read().await?;
        let mut fields = Fields::new(&bytes);
        if fields.byte()? != 2 || fields.u32()? != 3 {
            return Err(Error::Protocol);
        }
        let mut count = 0;
        while !fields.empty() {
            count += 1;
            if count > 64 {
                return Err(Error::Protocol);
            }
            let name = fields.string(256)?;
            let version = fields.string(4096)?;
            match (name, version) {
                (b"hardlink@openssh.com", b"1") => client.hardlink = true,
                (b"posix-rename@openssh.com", b"1") => client.rename = true,
                _ => {}
            }
        }
        client.healthy = true;
        Ok(client)
    }

    pub(super) fn healthy(&self) -> bool {
        self.healthy
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > PACKET {
            return Err(Error::Protocol);
        }
        self.stream.write_u32(bytes.len() as u32).await?;
        self.stream.write_all(bytes).await?;
        self.stream.flush().await?;
        Ok(())
    }

    async fn read(&mut self) -> Result<Vec<u8>, Error> {
        let size = self.stream.read_u32().await? as usize;
        if !(5..=PACKET).contains(&size) {
            return Err(Error::Protocol);
        }
        let mut bytes = vec![0; size];
        self.stream.read_exact(&mut bytes).await?;
        Ok(bytes)
    }

    async fn request(&mut self, kind: u8, body: Vec<u8>) -> Result<Reply, Error> {
        if !self.healthy {
            return Err(Error::Protocol);
        }
        self.healthy = false;
        self.id = self.id.checked_add(1).ok_or(Error::Protocol)?;
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&self.id.to_be_bytes());
        bytes.extend_from_slice(&body);
        self.write(&bytes).await?;
        let bytes = self.read().await?;
        let mut fields = Fields::new(&bytes);
        let kind = fields.byte()?;
        if fields.u32()? != self.id {
            return Err(Error::Protocol);
        }
        let reply = match kind {
            101 => {
                let code = fields.u32()?;
                fields.string(4096)?;
                fields.string(256)?;
                Reply::Status(code)
            }
            102 => {
                let handle = fields.string(HANDLE)?;
                Reply::Handle(handle.to_vec())
            }
            103 => {
                let data = fields.string(CHUNK)?;
                if data.is_empty() {
                    return Err(Error::Protocol);
                }
                Reply::Data(data.to_vec())
            }
            104 => {
                if fields.u32()? != 1 {
                    return Err(Error::Protocol);
                }
                let path = fields.string(PATH_BYTES)?.to_vec();
                fields.string(PATH_BYTES)?;
                fields.attrs()?;
                Reply::Name(path)
            }
            105 => Reply::Attrs(fields.attrs()?),
            _ => return Err(Error::Protocol),
        };
        fields.finish()?;
        self.healthy = true;
        Ok(reply)
    }

    fn unexpected(&mut self) -> Error {
        self.healthy = false;
        Error::Protocol
    }

    fn status(&mut self, reply: Reply) -> Result<(), Error> {
        match reply {
            Reply::Status(0) => Ok(()),
            Reply::Status(code) => Err(Error::Status(code)),
            _ => Err(self.unexpected()),
        }
    }

    pub(super) async fn realpath(&mut self, path: &str) -> Result<String, Error> {
        let reply = self.request(16, path_body(path)?).await?;
        match reply {
            Reply::Name(bytes) => match String::from_utf8(bytes) {
                Ok(path) if path.starts_with('/') && !path.contains('\0') => Ok(path),
                _ => Err(self.unexpected()),
            },
            Reply::Status(code) if code != 0 => Err(Error::Status(code)),
            _ => Err(self.unexpected()),
        }
    }

    async fn attrs(&mut self, kind: u8, body: Vec<u8>) -> Result<Attrs, Error> {
        match self.request(kind, body).await? {
            Reply::Attrs(attrs) => Ok(attrs),
            Reply::Status(code) if code != 0 => Err(Error::Status(code)),
            _ => Err(self.unexpected()),
        }
    }

    pub(super) async fn lstat(&mut self, path: &str) -> Result<Option<Attrs>, Error> {
        match self.attrs(7, path_body(path)?).await {
            Err(Error::Status(2)) => Ok(None),
            result => result.map(Some),
        }
    }

    pub(super) async fn fstat(&mut self, handle: &[u8]) -> Result<Attrs, Error> {
        let mut body = Vec::new();
        string(&mut body, handle)?;
        self.attrs(8, body).await
    }

    pub(super) async fn open(&mut self, path: &str, create: bool) -> Result<Vec<u8>, Error> {
        let mut body = path_body(path)?;
        body.extend_from_slice(&(if create { 2_u32 | 8 | 32 } else { 1_u32 }).to_be_bytes());
        body.extend_from_slice(&4_u32.to_be_bytes());
        body.extend_from_slice(&0o600_u32.to_be_bytes());
        match self.request(3, body).await? {
            Reply::Handle(handle) => Ok(handle),
            Reply::Status(code) if code != 0 => Err(Error::Status(code)),
            _ => Err(self.unexpected()),
        }
    }

    pub(super) async fn close(&mut self, handle: &[u8]) -> Result<(), Error> {
        let mut body = Vec::new();
        string(&mut body, handle)?;
        let reply = self.request(4, body).await?;
        self.status(reply)
    }

    pub(super) async fn read_file(
        &mut self,
        handle: &[u8],
        offset: u64,
    ) -> Result<Option<Vec<u8>>, Error> {
        let mut body = Vec::new();
        string(&mut body, handle)?;
        body.extend_from_slice(&offset.to_be_bytes());
        body.extend_from_slice(&(CHUNK as u32).to_be_bytes());
        match self.request(5, body).await? {
            Reply::Data(bytes) => Ok(Some(bytes)),
            Reply::Status(1) => Ok(None),
            Reply::Status(code) if code != 0 => Err(Error::Status(code)),
            _ => Err(self.unexpected()),
        }
    }

    pub(super) async fn write_file(
        &mut self,
        handle: &[u8],
        offset: u64,
        bytes: &[u8],
    ) -> Result<(), Error> {
        if bytes.is_empty() || bytes.len() > CHUNK {
            return Err(Error::Protocol);
        }
        let mut body = Vec::new();
        string(&mut body, handle)?;
        body.extend_from_slice(&offset.to_be_bytes());
        string(&mut body, bytes)?;
        let reply = self.request(6, body).await?;
        self.status(reply)
    }

    pub(super) async fn mkdir(&mut self, path: &str) -> Result<(), Error> {
        let mut body = path_body(path)?;
        body.extend_from_slice(&4_u32.to_be_bytes());
        body.extend_from_slice(&0o700_u32.to_be_bytes());
        let reply = self.request(14, body).await?;
        self.status(reply)
    }

    pub(super) async fn remove(&mut self, path: &str, directory: bool) -> Result<(), Error> {
        let reply = self
            .request(if directory { 15 } else { 13 }, path_body(path)?)
            .await?;
        self.status(reply)
    }

    pub(super) async fn publish(
        &mut self,
        source: &str,
        destination: &str,
        overwrite: bool,
    ) -> Result<(), Error> {
        let mut body = Vec::new();
        string(
            &mut body,
            if overwrite {
                b"posix-rename@openssh.com"
            } else {
                b"hardlink@openssh.com"
            },
        )?;
        body.extend_from_slice(&path_body(source)?);
        body.extend_from_slice(&path_body(destination)?);
        let reply = self.request(200, body).await?;
        self.status(reply)
    }
}

fn path_body(path: &str) -> Result<Vec<u8>, Error> {
    if path.is_empty() || path.len() > PATH_BYTES || path.contains('\0') {
        return Err(Error::Protocol);
    }
    let mut body = Vec::new();
    string(&mut body, path.as_bytes())?;
    Ok(body)
}
