//! Resolver capacity belongs to the blocking work, including cancelled waiters.

use std::{
    net::{SocketAddr, ToSocketAddrs},
    sync::Arc,
};
use tokio::sync::Semaphore;

use super::Failure;

#[derive(Clone)]
pub(super) struct Resolver {
    slots: Arc<Semaphore>,
}

impl Resolver {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
        }
    }

    pub(super) async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, Failure> {
        if !super::diagnostics::in_domain() || !super::region_map::hostname(host) || port == 0 {
            return Err(Failure::DomainFailed);
        }
        if let Ok(ip) = host.parse() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let permit = Arc::clone(&self.slots)
            .try_acquire_owned()
            .map_err(|_| Failure::ResourceExhausted)?;
        let host = host.to_owned();
        // Dropping this async join cannot release the permit retained by libc
        // resolver work. The owning runtime joins every blocking descendant.
        tokio::task::spawn_blocking(move || {
            let _capacity = permit;
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.take(32).collect())
        })
        .await
        .map_err(|_| Failure::DomainFailed)?
        .map_err(|_| Failure::DomainFailed)
    }

    pub(super) async fn connect(
        &self,
        host: &str,
        port: u16,
    ) -> Result<tokio::net::TcpStream, Failure> {
        for address in self.resolve(host, port).await? {
            if let Ok(io) = tokio::net::TcpStream::connect(address).await {
                return Ok(io);
            }
        }
        Err(Failure::DomainFailed)
    }
}
