use crate::{
    Categories, ChannelError, Error, Notice, Operation, Params, Peer, Service, ServiceFuture,
};
use api_contracts::generated::constants::sandbox_channel as limits;
use serde_json::Value;
use std::collections::BTreeMap;

/// The complete diagnostics v1 Guest role; no filesystem category is installed.
pub struct Diagnostics;

impl Service for Diagnostics {
    fn categories(&self) -> Categories {
        BTreeMap::from([(
            "diagnostics".to_owned(),
            u64::from(limits::diagnostics::VERSION),
        )])
    }
    fn request(&self, operation: Operation, params: Params, peer: Peer) -> ServiceFuture<Value> {
        Box::pin(async move {
            let echo = match (operation, params) {
                (Operation::Echo, Params::Echo(echo)) => echo,
                (Operation::PeerEcho, Params::Echo(echo)) => peer.echo(echo).await?,
                _ => return Err(ChannelError::UnknownOperation.into()),
            };
            serde_json::to_value(echo).map_err(|_| Error::Unavailable)
        })
    }
    fn notice(&self, _notice: Notice, _peer: Peer) -> ServiceFuture<()> {
        Box::pin(async { Ok(()) })
    }
}
