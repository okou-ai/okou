use crate::ProtocolError;

/// Last observed guest file-write lifecycle boundary, not terminal proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum FileWriteStage {
    /// No file write has been admitted on this connection.
    Idle = 0,
    /// The dispatcher admitted a request to the file-write worker.
    Queued = 1,
    /// The worker is starting the fixed file-write helper.
    StartingHelper = 2,
    /// The helper exists; pipe setup, child wait, or reaping is pending.
    WaitingForHelper = 3,
    /// The helper wait returned; the stdin writer is being joined.
    JoiningStdin = 4,
    /// The stderr drain is being completed and joined.
    DrainingStderr = 5,
    /// A terminal response is ready and waiting for the shared writer.
    WaitingForWriter = 6,
    /// The terminal response owns the shared writer.
    WritingResponse = 7,
    /// The complete terminal frame was written, not necessarily received.
    ResponseSent = 8,
}

impl FileWriteStage {
    /// Fixed, payload-free label for structured diagnostics.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Queued => "queued",
            Self::StartingHelper => "starting_helper",
            Self::WaitingForHelper => "waiting_for_helper",
            Self::JoiningStdin => "joining_stdin",
            Self::DrainingStderr => "draining_stderr",
            Self::WaitingForWriter => "waiting_for_writer",
            Self::WritingResponse => "writing_response",
            Self::ResponseSent => "response_sent",
        }
    }
}

/// Constant-space snapshot of the latest admitted write on one connection.
///
/// The sequence is the original write request's sequence, not the diagnostic
/// query's sequence. A different sequence cannot establish whether an older
/// request was received. This snapshot never proves a write's success.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileWriteStatus {
    /// Latest write sequence, or zero before any write is admitted.
    pub sequence: u32,
    /// Last recorded lifecycle boundary for that sequence.
    pub stage: FileWriteStage,
}

impl FileWriteStatus {
    /// Encode `[4B sequence][1B stage]` without any request content.
    pub fn encode_payload(self) -> [u8; 5] {
        let mut payload = [0; 5];
        payload[..4].copy_from_slice(&self.sequence.to_be_bytes());
        payload[4] = self.stage as u8;
        payload
    }

    /// Decode the exact fixed-width schema and its idle/sequence invariant.
    pub fn decode_payload(payload: &[u8]) -> Result<Self, ProtocolError> {
        let [a, b, c, d, stage] = payload else {
            return Err(ProtocolError::InvalidPayload(
                "invalid file-write status length",
            ));
        };
        let stage = match stage {
            0 => FileWriteStage::Idle,
            1 => FileWriteStage::Queued,
            2 => FileWriteStage::StartingHelper,
            3 => FileWriteStage::WaitingForHelper,
            4 => FileWriteStage::JoiningStdin,
            5 => FileWriteStage::DrainingStderr,
            6 => FileWriteStage::WaitingForWriter,
            7 => FileWriteStage::WritingResponse,
            8 => FileWriteStage::ResponseSent,
            _ => {
                return Err(ProtocolError::InvalidPayload(
                    "invalid file-write status stage",
                ));
            }
        };
        let sequence = u32::from_be_bytes([*a, *b, *c, *d]);
        if (sequence == 0) != (stage == FileWriteStage::Idle) {
            return Err(ProtocolError::InvalidPayload(
                "invalid file-write status sequence",
            ));
        }
        Ok(Self { sequence, stage })
    }
}

#[cfg(test)]
mod tests;
