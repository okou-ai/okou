//! One invocation-owned blocking kernel read, retained outside observed futures.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use tokio::sync::watch;

pub struct Gate {
    reader: Mutex<Option<UnixStream>>,
    writer: Mutex<Option<UnixStream>>,
    entered: watch::Sender<bool>,
}

impl Gate {
    pub fn new() -> io::Result<Self> {
        let (reader, writer) = UnixStream::pair()?;
        Ok(Self {
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            entered: watch::channel(false).0,
        })
    }

    pub fn blocking_wait(&self) -> io::Result<()> {
        let mut reader = self
            .reader
            .lock()
            .map_err(|_| io::Error::other("IO gate poisoned"))?
            .take()
            .ok_or_else(|| io::Error::other("IO gate already consumed"))?;
        self.entered.send_replace(true);
        let mut byte = [0];
        reader.read_exact(&mut byte)?;
        if byte != [0x47] {
            return Err(io::Error::other("IO gate release changed"));
        }
        Ok(())
    }

    pub async fn wait_entered(&self) -> io::Result<()> {
        let mut entered = self.entered.subscribe();
        loop {
            if *entered.borrow_and_update() {
                return Ok(());
            }
            entered.changed().await.map_err(io::Error::other)?;
        }
    }

    /// Idempotent release also lets refusal cleanup join an already accepted read.
    pub fn release(&self) -> io::Result<()> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("IO gate poisoned"))?
            .take();
        if let Some(mut writer) = writer {
            writer.write_all(&[0x47])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
