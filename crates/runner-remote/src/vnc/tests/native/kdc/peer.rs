//! Independent framed KDC peer; records actual requests and incomplete delivery.
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(crate) enum Reply {
    Complete,
    Empty,
    Oversized,
    Partial,
    Cancel,
    Hold,
}

pub(crate) struct Peer {
    pub(crate) address: std::net::SocketAddr,
    pub(crate) requests: Arc<AtomicUsize>,
    pub(crate) received: Arc<tokio::sync::Notify>,
    task: JoinHandle<()>,
}

impl Peer {
    pub(crate) async fn new(reply: Reply, cancel: CancellationToken) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&requests);
        let received = Arc::new(tokio::sync::Notify::new());
        let announced = Arc::clone(&received);
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let length = stream.read_u32().await.unwrap();
                assert_eq!(length, 4);
                let mut body = [0; 4];
                stream.read_exact(&mut body).await.unwrap();
                assert_eq!(&body, b"test");
                seen.fetch_add(1, Ordering::SeqCst);
                announced.notify_one();
                match reply {
                    Reply::Complete => {
                        stream.write_u32(5).await.unwrap();
                        stream.write_all(b"reply").await.unwrap();
                    }
                    Reply::Empty => stream.write_u32(0).await.unwrap(),
                    Reply::Oversized => stream.write_u32(65537).await.unwrap(),
                    Reply::Partial => {
                        stream.write_u32(5).await.unwrap();
                        stream.write_all(b"re").await.unwrap();
                    }
                    Reply::Cancel => cancel.cancel(),
                    Reply::Hold => std::future::pending().await,
                }
                stream.shutdown().await.unwrap();
            }
        });
        Self {
            address,
            requests,
            received,
            task,
        }
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
