use std::{io, sync::Arc};

use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::{TlsAcceptor, server::TlsStream};
use tokio_util::sync::CancellationToken;

pub(in crate::tailscale::tests::startup) async fn accept_tls(
    listener: &TcpListener,
    tls: Arc<rustls::ServerConfig>,
    stopped: &CancellationToken,
) -> Option<TlsStream<TcpStream>> {
    let acceptor = TlsAcceptor::from(tls);
    loop {
        let (socket, _) = tokio::select! { biased;
            _ = stopped.cancelled() => return None,
            socket = listener.accept() => socket.unwrap(),
        };
        let handshake = tokio::select! { biased;
            _ = stopped.cancelled() => return None,
            handshake = acceptor.accept(socket) => handshake,
        };
        match handshake {
            Ok(stream) => return Some(stream),
            // A disconnected unauthenticated socket must not consume the
            // listener reserved for the genuine native startup.
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => continue,
            // Preserve genuine TLS rejection, including untrusted roots.
            Err(_) => return None,
        }
    }
}
