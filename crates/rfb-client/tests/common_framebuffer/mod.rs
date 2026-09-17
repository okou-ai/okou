use std::{future::Future, io, sync::Arc, time::Duration};

use rfb_client::{
    Authenticated, Error, FramebufferConnection, TrustRoots, VncPassword, authenticate,
};
use rustls::{ServerConfig, pki_types::PrivatePkcs8KeyDer};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{Instant, timeout},
};
use tokio_rustls::{TlsAcceptor, server::TlsStream};

pub type Client = FramebufferConnection<TcpStream>;
pub type Peer = TlsStream<TcpStream>;

pub const RGBX: [u8; 16] = [32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0];
pub const RED: [u8; 4] = [255, 0, 0, 255];
pub const GREEN: [u8; 4] = [0, 255, 0, 255];
pub const BLUE: [u8; 4] = [0, 0, 255, 255];
pub const BLACK: [u8; 4] = [0, 0, 0, 255];
pub const WHITE: [u8; 4] = [255, 255, 255, 255];

pub fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(10)
}

pub async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(10), future).await.unwrap()
}

pub async fn authenticated() -> (Authenticated<TcpStream>, Peer) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["vnc.example.test".to_owned()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let roots = TrustRoots::custom(vec![cert.der().clone()]).unwrap();
    let config = ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        PrivatePkcs8KeyDer::from(key.serialize_der()).into(),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (client, server) = bounded(async {
        tokio::join!(
            TcpStream::connect(listener.local_addr().unwrap()),
            listener.accept(),
        )
    })
    .await;
    let client = client.unwrap();
    let mut server = server.unwrap().0;
    client.set_nodelay(true).unwrap();
    server.set_nodelay(true).unwrap();
    let caller = authenticate(
        client,
        "vnc.example.test",
        VncPassword::new(" secret ".to_owned()).unwrap(),
        roots,
        deadline(),
    );
    let peer = async {
        server.write_all(b"RFB 003.008\n").await.unwrap();
        let mut banner = [0; 12];
        server.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"RFB 003.008\n");
        server.write_all(&[1, 19]).await.unwrap();
        assert_eq!(server.read_u8().await.unwrap(), 19);
        server.write_all(&[0, 2]).await.unwrap();
        assert_eq!(server.read_u16().await.unwrap(), 2);
        server.write_all(&[0, 1]).await.unwrap();
        server.write_u32(261).await.unwrap();
        assert_eq!(server.read_u32().await.unwrap(), 261);
        server.write_u8(1).await.unwrap();
        let mut server = TlsAcceptor::from(Arc::new(config))
            .accept(server)
            .await
            .unwrap();
        server.write_all(b"0123456789abcdef").await.unwrap();
        server.flush().await.unwrap();
        let mut response = [0; 16];
        server.read_exact(&mut response).await.unwrap();
        // Independent DES-ECB vector, also used by the authentication suite.
        assert_eq!(
            response,
            [
                0x34, 0x57, 0xe0, 0xfd, 0xf6, 0xe8, 0x42, 0x5e, 0x58, 0xb4, 0xdf, 0x6b, 0x1b, 0xe5,
                0x22, 0x13,
            ]
        );
        server.write_u32(0).await.unwrap();
        server.flush().await.unwrap();
        server
    };
    let (client, server) = bounded(async { tokio::join!(caller, peer) }).await;
    (client.unwrap(), server)
}

pub fn server_init(width: u16, height: u16, pixel_format: [u8; 16], name: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend(width.to_be_bytes());
    bytes.extend(height.to_be_bytes());
    bytes.extend(pixel_format);
    bytes.extend(u32::try_from(name.len()).unwrap().to_be_bytes());
    bytes.extend(name);
    bytes
}

pub async fn negotiate_framebuffer(peer: &mut Peer, init: &[u8]) {
    assert_eq!(peer.read_u8().await.unwrap(), 1, "shared ClientInit");
    peer.write_all(init).await.unwrap();
    peer.flush().await.unwrap();
    let mut format = [0; 20];
    peer.read_exact(&mut format).await.unwrap();
    assert_eq!(&format[..4], &[0; 4]);
    assert_eq!(&format[4..], &RGBX);
    let mut encodings = [0; 24];
    peer.read_exact(&mut encodings).await.unwrap();
    assert_eq!(&encodings[..4], &[2, 0, 0, 5]);
    for (bytes, value) in encodings[4..]
        .as_chunks::<4>()
        .0
        .iter()
        .zip([16_i32, 1, 0, -239, -223])
    {
        assert_eq!(*bytes, value.to_be_bytes());
    }
}

pub async fn initialized(width: u16, height: u16) -> (Client, Peer) {
    initialized_with_format(width, height, RGBX).await
}

pub async fn initialized_with_format(width: u16, height: u16, format: [u8; 16]) -> (Client, Peer) {
    let (client, mut peer) = authenticated().await;
    let init = server_init(width, height, format, b"fixture desktop");
    let (client, ()) = bounded(async {
        tokio::join!(
            client.initialize(deadline()),
            negotiate_framebuffer(&mut peer, &init)
        )
    })
    .await;
    (client.unwrap(), peer)
}

pub async fn read_request(peer: &mut Peer, incremental: bool, width: u16, height: u16) {
    let mut request = [0; 10];
    peer.read_exact(&mut request).await.unwrap();
    let mut expected = vec![3, u8::from(incremental), 0, 0, 0, 0];
    expected.extend(width.to_be_bytes());
    expected.extend(height.to_be_bytes());
    assert_eq!(request.as_slice(), expected);
}

pub fn rectangle(x: u16, y: u16, width: u16, height: u16, encoding: i32, data: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [x, y, width, height] {
        bytes.extend(value.to_be_bytes());
    }
    bytes.extend(encoding.to_be_bytes());
    bytes.extend(data);
    bytes
}

pub fn raw(x: u16, y: u16, width: u16, height: u16, pixels: &[[u8; 4]]) -> Vec<u8> {
    assert_eq!(usize::from(width) * usize::from(height), pixels.len());
    let mut bytes = Vec::new();
    for pixel in pixels {
        bytes.extend([pixel[0], pixel[1], pixel[2], 0]);
    }
    rectangle(x, y, width, height, 0, &bytes)
}

pub fn copy_rect(x: u16, y: u16, width: u16, height: u16, src_x: u16, src_y: u16) -> Vec<u8> {
    let mut bytes = Vec::from(src_x.to_be_bytes());
    bytes.extend(src_y.to_be_bytes());
    rectangle(x, y, width, height, 1, &bytes)
}

pub fn update_message(rectangles: &[Vec<u8>]) -> Vec<u8> {
    let mut bytes = vec![0, 0];
    bytes.extend(u16::try_from(rectangles.len()).unwrap().to_be_bytes());
    for rectangle in rectangles {
        bytes.extend(rectangle);
    }
    bytes
}

pub async fn apply_bytes(
    client: Client,
    peer: &mut Peer,
    incremental: bool,
    bytes: &[u8],
) -> Result<Client, Error> {
    let width = client.width();
    let height = client.height();
    let caller = client.update(incremental, deadline());
    let server = async {
        read_request(peer, incremental, width, height).await;
        peer.write_all(bytes).await.unwrap();
        peer.flush().await.unwrap();
    };
    let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
    result
}

pub async fn apply(
    client: Client,
    peer: &mut Peer,
    incremental: bool,
    rectangles: &[Vec<u8>],
) -> Client {
    apply_bytes(client, peer, incremental, &update_message(rectangles))
        .await
        .unwrap()
}

pub fn zrle(x: u16, y: u16, width: u16, height: u16, compressed: &[u8]) -> Vec<u8> {
    let mut data = Vec::from(u32::try_from(compressed.len()).unwrap().to_be_bytes());
    data.extend(compressed);
    rectangle(x, y, width, height, 16, &data)
}

pub fn pixels(colors: &[[u8; 4]]) -> Vec<u8> {
    colors.iter().flatten().copied().collect()
}

pub fn error<T>(result: Result<T, Error>) -> Error {
    match result {
        Err(error) => error,
        Ok(_) => panic!("expected failure, got success"),
    }
}

pub async fn disconnected(peer: &mut Peer) {
    let mut byte = [0];
    match bounded(peer.read(&mut byte)).await {
        Ok(0) => {}
        Err(error) => assert!(
            matches!(
                error.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
            ),
            "{error:?}"
        ),
        result => panic!("expected a closed peer, got {result:?}"),
    }
}

pub async fn rejected_init(init: &[u8]) -> Error {
    let (client, mut peer) = authenticated().await;
    let caller = client.initialize(deadline());
    let server = async {
        assert_eq!(peer.read_u8().await.unwrap(), 1);
        peer.write_all(init).await.unwrap();
        peer.flush().await.unwrap();
        disconnected(&mut peer).await;
    };
    let (result, ()) = bounded(async { tokio::join!(caller, server) }).await;
    error(result)
}
