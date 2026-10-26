//! Public SDK Noise and the actual native startup owner over controlled OS IO.
//! The synthetic Noise service is a protocol fixture, not a production stack.

mod logout;
mod tls;

pub(super) use tls::accept_tls;

use crate::tailscale::{Control, Failure, Work, registration::Registration};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt, TryStreamExt};
use http_body_util::{BodyExt, Full, Limited, StreamBody};
use hyper::{Response, service::service_fn};
use hyper_util::rt::{TokioExecutor, TokioIo};
use std::{
    convert::Infallible,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_util::{
    codec::Framed,
    io::{CopyToBytes, SinkWriter, StreamReader},
    sync::CancellationToken,
};
use tracing::instrument::WithSubscriber;
use ts_keys::{MachineKeyPair, MachinePublicKey};

pub(super) const DERIVED: &str = "tskey-auth-NOISE-CANARY-SYNTHETIC";
pub(super) const ACCEPTED: &[u8] = br#"{"User":{"ID":1},"Login":{"ID":1,"Provider":"synthetic","LoginName":"synthetic"},"NodeKeyExpired":false,"MachineAuthorized":true,"AuthURL":"","Error":""}"#;

pub(super) struct NoiseService {
    pub(super) address: std::net::SocketAddr,
    public: MachinePublicKey,
    pub(super) expected_client: Arc<Mutex<Option<MachinePublicKey>>>,
    pub(super) expected_auth: Arc<Mutex<String>>,
    pub(super) announced_home: Arc<Mutex<Vec<u32>>>,
    pub(super) home_status: Arc<Mutex<hyper::StatusCode>>,
    pub(super) logout: Arc<logout::Service>,
    pub(super) requested: Arc<tokio::sync::Notify>,
    pub(super) response: CancellationToken,
    pub(super) map_requested: Arc<tokio::sync::Notify>,
    pub(super) map_response: CancellationToken,
    pub(super) handshake_started: Arc<tokio::sync::Notify>,
    pub(super) handshake_continue: CancellationToken,
    pub(super) streaming_map: Arc<std::sync::atomic::AtomicBool>,
    pub(super) map_updates: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub(super) stopped: CancellationToken,
    pub(super) task: tokio::task::JoinHandle<()>,
}

impl NoiseService {
    pub(super) async fn new(body: Vec<u8>, corrupt_handshake: bool) -> Self {
        Self::with_map(body, corrupt_handshake, None).await
    }

    pub(super) async fn with_map(
        body: Vec<u8>,
        corrupt_handshake: bool,
        map: Option<Vec<u8>>,
    ) -> Self {
        Self::configured(body, corrupt_handshake, map, false, None).await
    }

    pub(super) async fn paused() -> Self {
        Self::configured(ACCEPTED.to_vec(), false, None, true, None).await
    }

    pub(super) async fn secure(
        body: Vec<u8>,
        map: Option<Vec<u8>>,
        pause_handshake: bool,
        tls: Arc<rustls::ServerConfig>,
    ) -> Self {
        Self::configured(body, false, map, pause_handshake, Some(tls)).await
    }

    pub(super) fn public_key(&self) -> MachinePublicKey {
        self.public
    }

    async fn configured(
        body: Vec<u8>,
        corrupt_handshake: bool,
        map: Option<Vec<u8>>,
        pause_handshake: bool,
        tls: Option<Arc<rustls::ServerConfig>>,
    ) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let keys = Arc::new(MachineKeyPair::random());
        let public = keys.public;
        let expected_client = Arc::new(Mutex::new(None::<MachinePublicKey>));
        let expected = Arc::clone(&expected_client);
        let expected_auth = Arc::new(Mutex::new(DERIVED.to_owned()));
        let auth = Arc::clone(&expected_auth);
        let announced_home = Arc::new(Mutex::new(Vec::new()));
        let home = Arc::clone(&announced_home);
        let home_status = Arc::new(Mutex::new(hyper::StatusCode::OK));
        let status = Arc::clone(&home_status);
        let logout = Arc::new(logout::Service::new());
        let logout_service = Arc::clone(&logout);
        let requested = Arc::new(tokio::sync::Notify::new());
        let seen = Arc::clone(&requested);
        let response = CancellationToken::new();
        let gate = response.clone();
        let map_requested = Arc::new(tokio::sync::Notify::new());
        let map_seen = Arc::clone(&map_requested);
        let map_response = CancellationToken::new();
        let map_gate = map_response.clone();
        let handshake_started = Arc::new(tokio::sync::Notify::new());
        let handshake_seen = Arc::clone(&handshake_started);
        let handshake_continue = CancellationToken::new();
        let handshake_gate = handshake_continue.clone();
        let streaming_map = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let streaming = Arc::clone(&streaming_map);
        let (map_updates, updates) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
        let updates = Arc::new(Mutex::new(Some(updates)));
        let stopped = CancellationToken::new();
        let stopping = stopped.clone();
        let task = tokio::spawn(
            async move {
                let uses_tls = tls.is_some();
                let socket: Box<dyn Duplex> = match tls {
                    Some(tls) => match accept_tls(&listener, tls, &stopping).await {
                        Some(stream) => Box::new(stream),
                        None => return,
                    },
                    None => Box::new(listener.accept().await.unwrap().0),
                };
                let child = Arc::new(Mutex::new(None));
                let retained_child = Arc::clone(&child);
                let service =
                    service_fn(move |mut request: hyper::Request<hyper::body::Incoming>| {
                        assert_eq!(request.method(), "POST");
                        assert_eq!(request.uri().path(), "/ts2021");
                        assert_eq!(request.headers()["host"], "controlplane.tailscale.com");
                        assert_eq!(request.headers()["upgrade"], "tailscale-control-protocol");
                        let initial = STANDARD
                            .decode(request.headers()["X-Tailscale-Handshake"].as_bytes())
                            .unwrap();
                        assert_eq!(
                            u16::from_be_bytes(initial[..2].try_into().unwrap()),
                            u16::from(ts_capabilityversion::CapabilityVersion::CURRENT)
                        );
                        assert_eq!(initial[2], ts_control_noise::MessageType::Initiation as u8);
                        assert_eq!(u16::from_be_bytes(initial[3..5].try_into().unwrap()), 96);
                        assert_eq!(initial.len(), 101);
                        let upgraded = hyper::upgrade::on(&mut request);
                        let keys = Arc::clone(&keys);
                        let expected = Arc::clone(&expected);
                        let auth = Arc::clone(&auth);
                        let home = Arc::clone(&home);
                        let status = Arc::clone(&status);
                        let logout = Arc::clone(&logout_service);
                        let body = body.clone();
                        let seen = Arc::clone(&seen);
                        let gate = gate.clone();
                        let map = map.clone();
                        let map_seen = Arc::clone(&map_seen);
                        let map_gate = map_gate.clone();
                        let handshake_seen = Arc::clone(&handshake_seen);
                        let handshake_gate = handshake_gate.clone();
                        let streaming = Arc::clone(&streaming);
                        let updates = Arc::clone(&updates);
                        let task = tokio::spawn(
                            async move {
                                let mut io = TokioIo::new(upgraded.await.unwrap());
                                let mut payload = initial[5..].to_vec();
                                let received = ts_noise::ik::ReceivedHandshake::new(
                                    &mut payload,
                                    ts_control::client::CONTROL_PROTOCOL_VERSION.as_bytes(),
                                    &keys.to_x25519_dalek(),
                                )
                                .unwrap();
                                assert_eq!(
                                    received.peer_static_pub.to_bytes(),
                                    expected
                                        .lock()
                                        .unwrap()
                                        .unwrap()
                                        .to_x25519_dalek()
                                        .to_bytes()
                                );
                                handshake_seen.notify_one();
                                if pause_handshake {
                                    // Never send a Noise response or reach registration. The
                                    // test releases this server after client physical join.
                                    handshake_gate.cancelled().await;
                                    let mut byte = [0; 1];
                                    match io.read(&mut byte).await {
                                        Ok(0) => {}
                                        // Destroying the socket with unread data can
                                        // produce a TCP reset instead of a FIN.
                                        Err(error)
                                            if error.kind() == io::ErrorKind::ConnectionReset => {}
                                        // Abrupt owned socket destruction cannot
                                        // send TLS close_notify. Rustls reports
                                        // this exact peer EOF as UnexpectedEof.
                                        Err(error)
                                            if uses_tls
                                                && error.kind() == io::ErrorKind::UnexpectedEof => {
                                        }
                                        result => panic!("retired peer must reach EOF: {result:?}"),
                                    }
                                    return;
                                }
                                let mut reply = vec![0; ts_noise::ik::ReceivedHandshake::RESP_SIZE];
                                let session = received.finish(&mut reply);
                                if corrupt_handshake {
                                    *reply.last_mut().unwrap() ^= 1;
                                }
                                io.write_all(&[ts_control_noise::MessageType::Response as u8])
                                    .await
                                    .unwrap();
                                io.write_all(&(reply.len() as u16).to_be_bytes())
                                    .await
                                    .unwrap();
                                io.write_all(&reply).await.unwrap();
                                io.flush().await.unwrap();
                                if corrupt_handshake {
                                    io.shutdown().await.unwrap();
                                    return;
                                }
                                // Only public SDK cryptographic/framing components. Standard
                                // Tokio combinators bridge this external service's split IO.
                                let framed =
                                    Framed::new(io, ts_control_noise::BiCodec::from(session));
                                let (sink, stream) = framed.split::<Bytes>();
                                let reader = StreamReader::new(stream.map_err(io::Error::other));
                                let writer = SinkWriter::new(CopyToBytes::new(
                                    sink.sink_map_err(io::Error::other),
                                ));
                                let registered = Arc::new(Mutex::new(
                                    None::<(String, serde_json::Value)>,
                                ));
                                let service = service_fn(
                                    move |request: hyper::Request<hyper::body::Incoming>| {
                                        let path = request.uri().path().to_owned();
                                        assert!(
                                            path == "/machine/register" || path == "/machine/map"
                                        );
                                        assert_eq!(request.method(), "POST");
                                        let header = request.headers().get("Ts-Lb").cloned();
                                        let body = body.clone();
                                        let seen = Arc::clone(&seen);
                                        let gate = gate.clone();
                                        let map = map.clone();
                                        let map_seen = Arc::clone(&map_seen);
                                        let map_gate = map_gate.clone();
                                        let registered = Arc::clone(&registered);
                                        let auth = Arc::clone(&auth);
                                        let home = Arc::clone(&home);
                                        let status = Arc::clone(&status);
                                        let logout = Arc::clone(&logout);
                                        let streaming = Arc::clone(&streaming);
                                        let updates = Arc::clone(&updates);
                                        async move {
                                            let bytes = Limited::new(request.into_body(), 8192)
                                                .collect()
                                                .await
                                                .unwrap()
                                                .to_bytes();
                                            let request: serde_json::Value =
                                                serde_json::from_slice(&bytes).unwrap();
                                            if path == "/machine/register" {
                                                assert_eq!(request["Ephemeral"], true);
                                                assert_eq!(
                                                    header.unwrap().to_str().unwrap(),
                                                    request["NodeKey"].as_str().unwrap()
                                                );
                                                if request.get("Expiry").is_some() {
                                                    let (node_key, hostinfo) = registered
                                                        .lock()
                                                        .unwrap()
                                                        .clone()
                                                        .unwrap();
                                                    return Ok(logout
                                                        .reply(request, node_key, hostinfo)
                                                        .await
                                                        .map(BodyExt::boxed_unsync));
                                                }
                                                assert_eq!(
                                                    request["Auth"]["AuthKey"],
                                                    *auth.lock().unwrap()
                                                );
                                                *registered.lock().unwrap() = Some((
                                                    request["NodeKey"].as_str().unwrap().to_owned(),
                                                    request["Hostinfo"].clone(),
                                                ));
                                                seen.notify_one();
                                                gate.cancelled().await;
                                                Ok::<_, Infallible>(Response::new(
                                                    Full::new(Bytes::from(body)).boxed_unsync(),
                                                ))
                                            } else {
                                                assert!(header.is_none());
                                                let (node_key, hostinfo) =
                                                    registered.lock().unwrap().clone().unwrap();
                                                assert_eq!(request["NodeKey"], node_key);
                                                let mut map_hostinfo = request["HostInfo"].clone();
                                                map_hostinfo
                                                    .as_object_mut()
                                                    .unwrap()
                                                    .remove("NetInfo");
                                                assert_eq!(
                                                    map_hostinfo, hostinfo,
                                                    "map requests must preserve the registered HostInfo"
                                                );
                                                if request
                                                    .get("Stream")
                                                    .is_none_or(|stream| stream == false)
                                                {
                                                    assert!(
                                                        request
                                                            .get("KeepAlive")
                                                            .is_none_or(|keep| keep == false)
                                                    );
                                                    assert_eq!(request["OmitPeers"], true);
                                                    assert!(
                                                        request.get("ReadOnly").is_none_or(
                                                            |read_only| read_only == false
                                                        )
                                                    );
                                                    assert!(request.get("Auth").is_none());
                                                    let preferred = request["HostInfo"]["NetInfo"]
                                                        ["PreferredDerp"]
                                                        .as_u64()
                                                        .unwrap();
                                                    home.lock()
                                                        .unwrap()
                                                        .push(u32::try_from(preferred).unwrap());
                                                    // Non-streaming OmitPeers updates may return
                                                    // only HTTP status, without a map frame.
                                                    return Ok(Response::builder()
                                                        .status(*status.lock().unwrap())
                                                        .body(
                                                            Full::new(Bytes::new()).boxed_unsync(),
                                                        )
                                                        .unwrap());
                                                }
                                                assert_eq!(request["Stream"], true);
                                                assert_eq!(request["KeepAlive"], true);
                                                assert!(
                                                    request
                                                        .get("OmitPeers")
                                                        .is_none_or(|x| x == false)
                                                );
                                                assert!(
                                                    request.get("Compress").is_none_or(|x| x == "")
                                                );
                                                assert!(request.get("Auth").is_none());
                                                assert!(
                                                    request["DiscoKey"]
                                                        .as_str()
                                                        .unwrap()
                                                        .starts_with("discokey:")
                                                );
                                                let mut bytes = map.unwrap();
                                                if let Ok(mut value) =
                                                    serde_json::from_slice::<serde_json::Value>(
                                                        &bytes,
                                                    )
                                                {
                                                    if value.pointer("/Node/Key")
                                                        == Some(&serde_json::json!("MATCH-REQUEST"))
                                                    {
                                                        value["Node"]["Key"] = node_key.into();
                                                    }
                                                    let body = serde_json::to_vec(&value).unwrap();
                                                    bytes =
                                                        (body.len() as u32).to_le_bytes().to_vec();
                                                    bytes.extend_from_slice(&body);
                                                }
                                                map_seen.notify_one();
                                                map_gate.cancelled().await;
                                                let body = if streaming
                                                    .load(std::sync::atomic::Ordering::Acquire)
                                                {
                                                    let first =
                                                        futures_util::stream::once(async move {
                                                            Ok::<_, Infallible>(
                                                                hyper::body::Frame::data(
                                                                    Bytes::from(bytes),
                                                                ),
                                                            )
                                                        });
                                                    let updates =
                                                        updates.lock().unwrap().take().unwrap();
                                                    let updates = futures_util::stream::unfold(
                                                        updates,
                                                        |mut updates| async move {
                                                            let body = updates.recv().await?;
                                                            Some((
                                                                Ok::<_, Infallible>(
                                                                    hyper::body::Frame::data(
                                                                        Bytes::from(body),
                                                                    ),
                                                                ),
                                                                updates,
                                                            ))
                                                        },
                                                    );
                                                    StreamBody::new(first.chain(updates))
                                                        .boxed_unsync()
                                                } else {
                                                    Full::new(Bytes::from(bytes)).boxed_unsync()
                                                };
                                                Ok(Response::new(body))
                                            }
                                        }
                                    },
                                );
                                let _ =
                                    hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                                        .serve_connection(
                                            TokioIo::new(Joined { reader, writer }),
                                            service,
                                        )
                                        .await;
                            }
                            .with_subscriber(tracing::Dispatch::none()),
                        );
                        *child.lock().unwrap() = Some(task);
                        async {
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(101)
                                    .header("Connection", "Upgrade")
                                    .header("Upgrade", "tailscale-control-protocol")
                                    .body(Full::new(Bytes::new()))
                                    .unwrap(),
                            )
                        }
                    });
                hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(socket), service)
                    .with_upgrades()
                    .await
                    .unwrap();
                let child = retained_child.lock().unwrap().take().unwrap();
                child.await.unwrap();
            }
            .with_subscriber(tracing::Dispatch::none()),
        );
        Self {
            address,
            public,
            expected_client,
            expected_auth,
            announced_home,
            logout,
            home_status,
            requested,
            response,
            map_requested,
            map_response,
            handshake_started,
            handshake_continue,
            streaming_map,
            map_updates,
            stopped,
            task,
        }
    }

    pub(super) fn work(&self) -> Work {
        let address = self.address;
        let public = self.public;
        let expected = Arc::clone(&self.expected_client);
        Box::new(move |control: Control| {
            Box::pin(async move {
                let profile = Registration::new();
                *expected.lock().unwrap() = Some(profile.keys().machine_keys.public);
                let socket = tokio::net::TcpStream::connect(address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                let client = profile.noise_register(socket, public, DERIVED).await?;
                control.ready();
                control.cancelled().cancelled().await;
                drop(client);
                Ok(())
            })
        })
    }

    pub(super) fn map_work(&self, expect_valid: bool) -> Work {
        let address = self.address;
        let public = self.public;
        let expected = Arc::clone(&self.expected_client);
        Box::new(move |control: Control| {
            Box::pin(async move {
                let profile = Registration::new();
                *expected.lock().unwrap() = Some(profile.keys().machine_keys.public);
                let socket = tokio::net::TcpStream::connect(address)
                    .await
                    .map_err(|_| Failure::DomainFailed)?;
                let client = profile.noise_register(socket, public, DERIVED).await?;
                let maps = profile.maps(&client).await?;
                tokio::pin!(maps);
                let update = maps.next().await.ok_or(Failure::DomainFailed)?;
                assert!(
                    expect_valid,
                    "rejected map frame cannot yield a state update"
                );
                let local = update.node.ok_or(Failure::DomainFailed)?;
                assert_eq!(local.node_key, profile.keys().node_keys.public);
                assert_eq!(local.hostname, "native");
                assert_eq!(local.tailnet.as_deref(), Some("synthetic.ts.net"));
                assert_eq!(local.tailnet_address.ipv4.addr().octets(), [100, 64, 0, 1]);
                assert_eq!(
                    local.tailnet_address.ipv6.addr().to_string(),
                    "fd7a:115c:a1e0::1"
                );
                control.ready();
                control.cancelled().cancelled().await;
                Ok(())
            })
        })
    }
}

struct Joined<R, W> {
    reader: R,
    writer: W,
}

trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}
impl<R: AsyncRead + Unpin, W: Unpin> AsyncRead for Joined<R, W> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, out)
    }
}
impl<R: Unpin, W: AsyncWrite + Unpin> AsyncWrite for Joined<R, W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}
