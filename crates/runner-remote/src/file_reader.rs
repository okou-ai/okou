//! One bounded sequential fs v3 consumer. The generic Guest transport remains opaque.
use crate::guest_duplex::{Channel, ChannelCancellation};
use api_contracts::generated::{constants::sandbox_channel as limits, types::sandbox_channel::fs};
use base64::{Engine, engine::general_purpose::STANDARD};
use guest_contracts::sandbox_channel::{self as contract, Message, Operation, ResultPayload};
use serde_json::{Value, json};
use std::{collections::BTreeMap, io, time::Duration};
use uuid::Uuid;

const REQUEST_WAIT: Duration = Duration::from_secs(10);
fn invalid() -> io::Error {
    io::Error::other("file reader protocol failed")
}

pub struct FileReader {
    channel: Channel,
    metadata: fs::OpenResult,
    offset: u64,
    size: u64,
    finished: bool,
    failed: bool,
}

impl FileReader {
    /// This exact channel owns its handles; dropping it retires abandoned readers.
    pub async fn open(mut channel: Channel, path: Vec<String>) -> io::Result<Self> {
        let id = Uuid::new_v4().to_string();
        let hello = json!({"schemaVersion":limits::SCHEMA_VERSION,"type":"hello","id":id,
            "categories":{"fs":limits::fs::VERSION}});
        let response = exchange(&mut channel, hello, &id).await?;
        let hello = contract::decode_hello_result(response).map_err(|_| invalid())?;
        contract::category_gate(
            "fs",
            u64::from(limits::fs::VERSION),
            &BTreeMap::from([("fs".into(), u64::from(limits::fs::VERSION))]),
            &hello.categories,
        )
        .map_err(|_| invalid())?;
        let params = json!({"path":path,"mode":"download"});
        contract::decode_params(Operation::FsOpen, params.clone()).map_err(|_| invalid())?;
        let result = call(&mut channel, "open", params).await?;
        let ResultPayload::FsOpen(metadata) =
            contract::decode_result(Operation::FsOpen, result).map_err(|_| invalid())?
        else {
            return Err(invalid());
        };
        if metadata.truncated || metadata.selected_size != metadata.file_size {
            return Err(invalid());
        }
        let size = metadata.file_size.parse::<u64>().map_err(|_| invalid())?;
        Ok(Self {
            channel,
            metadata,
            offset: 0,
            size,
            finished: false,
            failed: false,
        })
    }
    pub fn size(&self) -> u64 {
        self.size
    }
    pub fn display_name(&self) -> &str {
        &self.metadata.display_name
    }
    pub fn cancellation(&self) -> ChannelCancellation {
        self.channel.cancellation()
    }

    /// The final chunk is withheld until finish has validated the complete read.
    pub async fn next_chunk(&mut self) -> io::Result<Option<Vec<u8>>> {
        if self.failed {
            return Err(invalid());
        }
        // Dropping a partially polled framed exchange poisons this consumer too.
        self.failed = true;
        let result = self.next_inner().await;
        if result.is_ok() {
            self.failed = false;
        }
        result
    }

    async fn next_inner(&mut self) -> io::Result<Option<Vec<u8>>> {
        if self.finished {
            return Ok(None);
        }
        let remaining = self.size.checked_sub(self.offset).ok_or_else(invalid)?;
        if remaining == 0 {
            self.finish().await?;
            return Ok(None);
        }
        let length = remaining.min(u64::from(limits::fs::MAX_CHUNK_BYTES));
        let result = call(
            &mut self.channel,
            "read",
            json!({
                "handle":self.metadata.handle,"offset":self.offset.to_string(),"length":length,
            }),
        )
        .await?;
        let ResultPayload::FsRead(read) =
            contract::decode_result(Operation::FsRead, result).map_err(|_| invalid())?
        else {
            return Err(invalid());
        };
        if read.offset != self.offset.to_string() || read.length != length {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(&read.data).map_err(|_| invalid())?;
        self.offset = self.offset.checked_add(length).ok_or_else(invalid)?;
        if self.offset == self.size {
            self.finish().await?;
        }
        Ok(Some(bytes))
    }

    async fn finish(&mut self) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        let result = call(
            &mut self.channel,
            "finish",
            json!({"handle":self.metadata.handle}),
        )
        .await?;
        contract::decode_result(Operation::FsFinish, result).map_err(|_| invalid())?;
        self.finished = true;
        Ok(())
    }
}

async fn call(channel: &mut Channel, operation: &str, params: Value) -> io::Result<Value> {
    let id = Uuid::new_v4().to_string();
    exchange(channel, json!({"schemaVersion":limits::SCHEMA_VERSION,"type":"request","id":id,
        "category":"fs","categoryVersion":limits::fs::VERSION,"operation":operation,"params":params}), &id).await
}

async fn exchange(channel: &mut Channel, message: Value, id: &str) -> io::Result<Value> {
    tokio::time::timeout(REQUEST_WAIT, async {
        channel
            .send(&serde_json::to_vec(&message).map_err(|_| invalid())?)
            .await?;
        let frame = channel.recv().await?.ok_or_else(invalid)?;
        match contract::decode_message(&frame).map_err(|_| invalid())? {
            Message::Response {
                request_id,
                result: Some(value),
                error: None,
                ..
            } if request_id == id => Ok(value),
            _ => Err(invalid()),
        }
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "file reader request timed out"))?
}
