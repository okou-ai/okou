//! Guest-loopback CDP adapter. The production destination is always host CID 2.

use std::{future::Future, io, sync::Arc, time::Duration};

use api_contracts::generated::constants::browser::BROWSER_PROVIDER_TIMEOUT_MINUTES;
use futures_util::{SinkExt, StreamExt};
use runner_rpc_proto::{
    Response,
    stream::{Frame, Reader, Writer, messages},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
    sync::Mutex,
    task::JoinSet,
    time::{Instant, timeout, timeout_at},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};

pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_DURATION_MS: u64 = BROWSER_PROVIDER_TIMEOUT_MINUTES * 60 * 1000;

pub async fn run() -> io::Result<bool> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    println!(
        "{}",
        serde_json::json!({"cdpUrl": format!("ws://{}", listener.local_addr()?)})
    );
    serve(listener, crate::connect_vsock, std::future::pending()).await?;
    Ok(true)
}

/// The same adapter with caller-owned sockets for real Guest-entry fixtures.
/// No executable flag exposes a destination override or upstream capability.
pub async fn serve<C, F, S>(
    listener: TcpListener,
    connect: C,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()>
where
    C: Fn() -> F + Clone + Send + Sync + 'static,
    F: Future<Output = io::Result<S>> + Send,
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let mut tasks = JoinSet::new();
    let mut failure = None;
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            biased;
            () = &mut shutdown => break,
            _ = tasks.join_next(), if !tasks.is_empty() => {},
            accepted = listener.accept() => {
                let (stream, address) = match accepted { Ok(accepted) => accepted, Err(error) => { failure = Some(error); break; } };
                if !address.ip().is_loopback() || tasks.len() >= 8 { continue; }
                let connect = connect.clone();
                tasks.spawn(async move {
                    let _ = timeout(Duration::from_millis(MAX_DURATION_MS), bridge(stream, connect)).await;
                });
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    failure.map_or(Ok(()), Err)
}

async fn bridge<C, F, S>(stream: tokio::net::TcpStream, connect: C) -> io::Result<()>
where
    C: FnOnce() -> F,
    F: Future<Output = io::Result<S>>,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES));
    let ws = timeout(
        Duration::from_secs(10),
        accept_async_with_config(stream, Some(config)),
    )
    .await
    .map_err(|_| failed())?
    .map_err(|_| failed())?;
    let deadline = Instant::now() + Duration::from_millis(MAX_DURATION_MS);
    let request =
        runner_rpc_proto::parse_request(br#"{"version":1,"method":"browser.cdp","params":{}}"#)?;
    let mut sent = false;
    let rpc = timeout_at(
        deadline,
        crate::dispatch_request(request, connect, &mut sent, deadline, MAX_DURATION_MS),
    )
    .await
    .map_err(|_| failed())?
    .map_err(|_| failed())?;
    let (read, write) = tokio::io::split(rpc);
    let mut input = Reader::responses(read);
    let mut output = Writer::input(write);
    let (sink, mut source) = ws.split();
    let sink = Arc::new(Mutex::new(sink));
    let send = async {
        while let Some(message) = source.next().await {
            match message.map_err(|_| failed())? {
                Message::Text(text) => {
                    messages::write(&mut output, text.as_bytes(), MAX_MESSAGE_BYTES).await?
                }
                Message::Close(_) => break,
                Message::Ping(bytes) => sink
                    .lock()
                    .await
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| failed())?,
                Message::Pong(_) => {}
                _ => return Err(failed()),
            }
        }
        output.send(&Frame::End).await
    };
    let receive = async {
        let mut terminal = false;
        while let Some(message) = messages::read(&mut input, MAX_MESSAGE_BYTES).await? {
            match message {
                messages::Message::Data(bytes) => {
                    let text = String::from_utf8(bytes).map_err(|_| failed())?;
                    sink.lock()
                        .await
                        .send(Message::Text(text.into()))
                        .await
                        .map_err(|_| failed())?;
                }
                messages::Message::End => {}
                messages::Message::Control(Response::Result { .. }) => terminal = true,
                messages::Message::Control(Response::Error { .. }) => return Err(failed()),
                messages::Message::Control(Response::Event { .. }) => return Err(failed()),
            }
        }
        if terminal { Ok(()) } else { Err(failed()) }
    };
    tokio::pin!(receive);
    let result = tokio::select! {
        result = &mut receive => result,
        result = send => {
            result?;
            timeout(Duration::from_secs(5), &mut receive).await.map_err(|_| failed())?
        },
    };
    let _ = timeout(Duration::from_secs(1), sink.lock().await.close()).await;
    result
}

fn failed() -> io::Error {
    io::Error::new(
        io::ErrorKind::ConnectionAborted,
        "scoped Browser stream unavailable",
    )
}
