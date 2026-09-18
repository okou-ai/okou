use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use base64::Engine;
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore, mpsc},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::TlsAcceptor;
use tokio_util::sync::CancellationToken;

pub(super) enum Event {
    Mode(u8),
    Capture,
    Input(Vec<u8>),
    Closed,
}

pub(super) struct Peer {
    pub(super) address: std::net::SocketAddr,
    pub(super) ca: String,
    pub(super) capture_gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    pub(super) refuse: Arc<AtomicBool>,
    pub(super) disconnect: CancellationToken,
    events: Mutex<mpsc::UnboundedReceiver<Event>>,
    task: JoinHandle<()>,
}

impl Peer {
    pub(super) async fn new() -> Self {
        let root_key = rcgen::KeyPair::generate().unwrap();
        let mut root = rcgen::CertificateParams::default();
        root.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        root.key_usages = vec![
            rcgen::KeyUsagePurpose::KeyCertSign,
            rcgen::KeyUsagePurpose::DigitalSignature,
        ];
        let root_certificate = root.self_signed(&root_key).unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let certificate = rcgen::CertificateParams::new(vec!["vnc.example.test".into()])
            .unwrap()
            .signed_by(&key, &rcgen::Issuer::from_params(&root, &root_key))
            .unwrap();
        let config = ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.der().clone()],
            PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (events, receiver) = mpsc::unbounded_channel();
        let capture_gate = Arc::new(Mutex::new(None));
        let gate = Arc::clone(&capture_gate);
        let refuse = Arc::new(AtomicBool::new(false));
        let reject = Arc::clone(&refuse);
        let disconnect = CancellationToken::new();
        let disconnect_task = disconnect.clone();
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            let config = Arc::new(config);
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        let Ok((socket, _)) = result else { break; };
                        let config = Arc::clone(&config);
                        let events = events.clone();
                        let gate = Arc::clone(&gate);
                        let reject = Arc::clone(&reject);
                        let disconnect = disconnect_task.clone();
                        tasks.spawn(async move {
                            let _ = serve(socket, config, &events, gate, reject, disconnect).await;
                            let _ = events.send(Event::Closed);
                        });
                    }
                    result = tasks.join_next(), if !tasks.is_empty() => {
                        result.unwrap().unwrap();
                    }
                }
            }
        });
        Self {
            address,
            ca: format!(
                "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
                base64::engine::general_purpose::STANDARD.encode(root_certificate.der())
            ),
            capture_gate,
            refuse,
            disconnect,
            events: Mutex::new(receiver),
            task,
        }
    }

    pub(super) async fn event(&self) -> Event {
        super::harness::bounded(async { self.events.lock().await.recv().await.unwrap() }).await
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(
    mut socket: TcpStream,
    config: Arc<ServerConfig>,
    events: &mpsc::UnboundedSender<Event>,
    capture_gate: Arc<Mutex<Option<Arc<Semaphore>>>>,
    refuse: Arc<AtomicBool>,
    disconnect: CancellationToken,
) -> io::Result<()> {
    socket.set_nodelay(true)?;
    socket.write_all(b"RFB 003.008\n").await?;
    let mut banner = [0; 12];
    socket.read_exact(&mut banner).await?;
    assert_eq!(&banner, b"RFB 003.008\n");
    socket.write_all(&[1, 19]).await?;
    assert_eq!(socket.read_u8().await?, 19);
    socket.write_all(&[0, 2]).await?;
    assert_eq!(socket.read_u16().await?, 2);
    socket.write_all(&[0, 1]).await?;
    socket.write_u32(261).await?;
    assert_eq!(socket.read_u32().await?, 261);
    socket.write_u8(1).await?;
    let mut socket = TlsAcceptor::from(config).accept(socket).await?;
    socket.write_all(b"0123456789abcdef").await?;
    socket.flush().await?;
    let mut password_response = [0; 16];
    socket.read_exact(&mut password_response).await?;
    // Independent DES challenge vector for the printable password " secret ".
    assert_eq!(
        password_response,
        [
            0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5,
            0x22, 0x13
        ]
    );
    if refuse.load(Ordering::SeqCst) {
        socket.write_u32(1).await?;
        socket.write_u32(0).await?;
        socket.flush().await?;
        return Ok(());
    }
    socket.write_u32(0).await?;
    socket.flush().await?;
    let mode = socket.read_u8().await?;
    events.send(Event::Mode(mode)).unwrap();
    socket.write_u16(2).await?;
    socket.write_u16(1).await?;
    socket
        .write_all(&[32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0])
        .await?;
    socket.write_u32(0).await?;
    socket.flush().await?;
    loop {
        let tag = tokio::select! {
            biased;
            () = disconnect.cancelled() => {
                // Only an explicitly requested test disconnect uses RST. Normal
                // close drains preceding input before observing client EOF.
                socket.get_ref().0.set_zero_linger()?;
                return Ok(());
            }
            tag = socket.read_u8() => tag?,
        };
        match tag {
            0 => {
                let mut format = [0; 19];
                socket.read_exact(&mut format).await?;
            }
            2 => {
                assert_eq!(socket.read_u8().await?, 0);
                let count = socket.read_u16().await?;
                assert!(count <= 16);
                for _ in 0..count {
                    socket.read_i32().await?;
                }
            }
            3 => {
                let mut request = [0; 9];
                socket.read_exact(&mut request).await?;
                assert_eq!(&request[5..], &[0, 2, 0, 1]);
                events.send(Event::Capture).unwrap();
                if let Some(gate) = capture_gate.lock().await.clone() {
                    // A cancellation test must observe socket EOF even while the reply is held.
                    tokio::select! {
                        permit = gate.acquire() => { permit.unwrap().forget(); }
                        read = socket.read_u8() => {
                            assert!(read.is_err(), "unexpected input while capture is pending");
                            return Ok(());
                        }
                    }
                }
                // A complete independent Raw rectangle: opaque red and blue pixels.
                socket
                    .write_all(&[
                        0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0,
                    ])
                    .await?;
                socket.flush().await?;
            }
            tag @ (4 | 5) => {
                let mut message = vec![0; if tag == 4 { 8 } else { 6 }];
                message[0] = tag;
                socket.read_exact(&mut message[1..]).await?;
                events.send(Event::Input(message)).unwrap();
            }
            tag => panic!("unexpected RFB client message {tag}"),
        }
    }
}
