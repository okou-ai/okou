//! One independently authorized, bounded KDC TCP exchange; uncertainty is terminal.
use super::*;
use crate::vnc::sessions::Carrier;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

impl Caller<'_> {
    async fn authorize_in(&self, scope: &Scope) -> Result<(), kerberos_worker::Error> {
        scope
            .wait(self.runtime.authority.check(
                self.run,
                self.connection,
                self.generation,
                self.rfb,
                Some(self.binding),
            ))
            .await
            .map_err(|_| kerberos_worker::Error::Authority)?
            .map_err(|_| kerberos_worker::Error::Authority)?;
        scope.check().map_err(|_| kerberos_worker::Error::Authority)
    }
}

impl kerberos_worker::KdcExchange for Caller<'_> {
    fn work_owner(&self) -> Option<Arc<dyn WorkOwner>> {
        Some(Arc::clone(&self.owner))
    }
    async fn authorize(&mut self) -> Result<(), kerberos_worker::Error> {
        self.authorize_in(&self.scope).await
    }

    async fn exchange(
        &mut self,
        realm: &str,
        request: &[u8],
    ) -> Result<Zeroizing<Vec<u8>>, kerberos_worker::Error> {
        use kerberos_worker::Error as E;
        if self.awaiting_kdc_reply.load(Ordering::Relaxed) {
            return Err(E::DeliveryUnknown);
        }
        if realm != self.realm
            || request.is_empty()
            || request.len() > 65536
            || self.exchanges >= 16
            || self.total.saturating_add(request.len()) > 512 * 1024
        {
            return Err(E::Invalid);
        }
        let previous_source = self.diagnostics.source.clone();
        // Independent KDC setup must not label the RFB carrier as its source.
        self.diagnostics.source = crate::vnc::sessions::SourceEvidence::default();
        self.diagnostics.set(Stage::KdcTransport, Progress::Running);
        self.authorize().await?;
        let route = self.kdc.as_ref().ok_or(E::Authority)?;
        let host = route.host.clone();
        let port = route.port;
        let transport = route.transport;
        let mut stream = match transport {
            Transport::Cloudflare { .. } | Transport::Tailscale { .. } => {
                let configuration = route.native.as_deref().cloned().ok_or(E::Authority)?;
                let stream = self
                    .native
                    .dial(
                        configuration,
                        &host,
                        port,
                        &self.scope,
                        Arc::clone(&self.owner),
                        self.diagnostics,
                    )
                    .await
                    .map_err(|failure| match failure {
                        Failure::Cancelled | Failure::TimedOut | Failure::Authority => E::Authority,
                        Failure::ResourceExhausted => E::Capacity,
                        _ => E::KdcUnavailable,
                    })?;
                // Keep the node through subsequent online exchanges. Each TCP
                // stream has its own physical operation lease and exact tuple.
                self.kdc.as_mut().ok_or(E::Authority)?.node = stream.node();
                Carrier::Native(Box::new(stream))
            }
            Transport::Direct => {
                let network = Arc::clone(&self.runtime.network);
                let owner = Arc::clone(&self.owner);
                let resolve = self.tasks.spawn(async move {
                    let _owner = owner;
                    network::destination(network, &host, port).await
                });
                let address = self
                    .scope
                    .wait(resolve)
                    .await
                    .map_err(|_| E::Authority)?
                    .map_err(|_| E::KdcUnavailable)?
                    .map_err(|_| E::KdcUnavailable)?;
                if let Some(snapshot) = &mut self.diagnostics.vnc {
                    snapshot.kdc_address = Some(address);
                }
                self.authorize().await?;
                Carrier::Direct(
                    self.scope
                        .wait(self.runtime.network.connect(address))
                        .await
                        .map_err(|_| E::Authority)?
                        .map_err(|_| E::KdcUnavailable)?,
                )
            }
            Transport::Ssh {
                connection,
                generation,
            } => {
                let ssh = self.ssh.as_ref().ok_or(E::Authority)?;
                // Bound the enclosing GSSAPI future's stack use during nested SSH setup.
                let stream = self
                    .scope
                    .wait(Box::pin(ssh.open_direct_tcpip_diagnosed(
                        connection,
                        generation,
                        &host,
                        port,
                        self.scope.session.clone(),
                        self.scope.deadline,
                    )))
                    .await
                    .map_err(|_| E::Authority)?
                    .map_err(|failure| {
                        self.diagnostics.retain_ssh_failure(connection, *failure);
                        E::KdcUnavailable
                    })?;
                // The shared SSH authority permits only its attested first-use
                // host-key pin transition. Retain that generation and recheck
                // the independent KDC grant before sending any KDC bytes.
                let learned = Transport::Ssh {
                    connection,
                    generation: stream.generation(),
                };
                self.diagnostics.retain_ssh_stream(connection, &stream);
                self.binding
                    .record_ssh_generation(&mut self.kdc, transport, learned);
                Carrier::Ssh(Box::new(stream))
            }
        };
        let mut scope = self.scope.clone();
        if let Carrier::Native(stream) = &stream
            && let Some(guard) = stream.guard()
        {
            scope.native.push(guard);
        }
        self.diagnostics.set(Stage::KdcTransport, Progress::Passed);
        self.diagnostics.set(Stage::KdcExchange, Progress::Running);
        self.authorize_in(&scope).await?;
        self.exchanges += 1;
        self.total += request.len();
        // After a write is attempted every uncertain result is terminal. No retry.
        scope
            .wait(async {
                self.awaiting_kdc_reply.store(true, Ordering::Relaxed);
                stream
                    .write_all(&(request.len() as u32).to_be_bytes())
                    .await
            })
            .await
            .map_err(|_| {
                if self.awaiting_kdc_reply.load(Ordering::Relaxed) {
                    E::DeliveryUnknown
                } else {
                    E::Authority
                }
            })?
            .map_err(|_| E::DeliveryUnknown)?;
        self.authorize_in(&scope)
            .await
            .map_err(|_| E::DeliveryUnknown)?;
        scope
            .wait(stream.write_all(request))
            .await
            .map_err(|_| E::DeliveryUnknown)?
            .map_err(|_| E::DeliveryUnknown)?;
        scope
            .wait(stream.flush())
            .await
            .map_err(|_| E::DeliveryUnknown)?
            .map_err(|_| E::DeliveryUnknown)?;
        let size = scope
            .wait(stream.read_u32())
            .await
            .map_err(|_| E::DeliveryUnknown)?
            .map_err(|_| E::DeliveryUnknown)? as usize;
        if !(1..=65536).contains(&size) || self.total.saturating_add(size) > 512 * 1024 {
            return Err(E::DeliveryUnknown);
        }
        let mut reply = Zeroizing::new(vec![0; size]);
        scope
            .wait(stream.read_exact(&mut reply))
            .await
            .map_err(|_| E::DeliveryUnknown)?
            .map_err(|_| E::DeliveryUnknown)?;
        scope.check().map_err(|_| E::DeliveryUnknown)?;
        self.total += size;
        self.awaiting_kdc_reply.store(false, Ordering::Relaxed);
        self.diagnostics.set(Stage::KdcExchange, Progress::Passed);
        self.diagnostics.source = previous_source;
        Ok(reply)
    }
}
