//! A fixture-owned TLS peer forwarding to the real Runner Unix listener.
//! Only DNS resolution and the test CA differ from the public health client.

use super::*;
use tokio::net::{TcpListener, UnixStream};
use tokio::sync::{Notify, Semaphore};

pub(crate) const HOST: &str = "runner-ingress.example.org";
pub(crate) const TOKEN: &str = "synthetic-official-runner-credential";

pub(crate) struct PublicIngress {
    pub client: reqwest::Client,
    connected: Arc<Notify>,
    gate: Arc<Semaphore>,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl PublicIngress {
    pub async fn start(upstream: PathBuf) -> Self {
        let certificate = rcgen::generate_simple_self_signed(vec![HOST.into()]).unwrap();
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der())
                .into(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HEALTH_TIMEOUT)
            .tls_certs_only([reqwest::Certificate::from_der(certificate.cert.der()).unwrap()])
            .resolve(HOST, listener.local_addr().unwrap())
            .build()
            .unwrap();
        let connected = Arc::new(Notify::new());
        let gate = Arc::new(Semaphore::new(0));
        let cancel = CancellationToken::new();
        let task = {
            let connected = connected.clone();
            let gate = gate.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
                let mut connections = JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => break,
                        Some(result) = connections.join_next(), if !connections.is_empty() => result.unwrap(),
                        accepted = listener.accept() => {
                            let (stream, _) = accepted.unwrap();
                            let acceptor = acceptor.clone();
                            let connected = connected.clone();
                            let gate = gate.clone();
                            let upstream = upstream.clone();
                            connections.spawn(async move {
                                let mut stream = acceptor.accept(stream).await.unwrap();
                                connected.notify_one();
                                let _permit = gate.acquire().await.unwrap();
                                let mut upstream = UnixStream::connect(upstream).await.unwrap();
                                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                            });
                        }
                    }
                }
                connections.abort_all();
                while connections.join_next().await.is_some() {}
            })
        };
        Self {
            client,
            connected,
            gate,
            cancel,
            task: Some(task),
        }
    }

    pub async fn wait_connected(&self) {
        tokio::time::timeout(Duration::from_secs(5), self.connected.notified())
            .await
            .unwrap();
    }

    pub fn allow_health(&self) {
        self.gate.add_permits(1);
    }

    pub async fn shutdown(mut self) {
        self.cancel.cancel();
        self.task.take().unwrap().await.unwrap();
    }
}

impl Drop for PublicIngress {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
