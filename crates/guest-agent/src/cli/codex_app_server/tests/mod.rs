use std::cell::Cell;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, Waker, ready};

use futures_util::FutureExt;
use tokio::io::{AsyncBufRead, AsyncRead, ReadBuf};

use super::{app_server_args, read_stdout_line};

struct GatedStdout<'a> {
    bytes: &'a [u8],
    available: usize,
    consumed: &'a Cell<usize>,
}

impl AsyncRead for GatedStdout<'_> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let bytes = ready!(self.as_mut().poll_fill_buf(cx))?;
        let count = bytes.len().min(output.remaining());
        output.put_slice(&bytes[..count]);
        self.consume(count);
        Poll::Ready(Ok(()))
    }
}

impl AsyncBufRead for GatedStdout<'_> {
    fn poll_fill_buf(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<&[u8]>> {
        let reader = self.get_mut();
        let consumed = reader.consumed.get();
        if consumed == reader.available && consumed < reader.bytes.len() {
            // Only an explicit release exposes the suffix. This is not EOF.
            Poll::Pending
        } else {
            Poll::Ready(Ok(&reader.bytes[consumed..reader.available]))
        }
    }

    fn consume(self: Pin<&mut Self>, amount: usize) {
        let consumed = self.consumed.get();
        assert!(amount <= self.available - consumed);
        self.consumed.set(consumed + amount);
    }
}

#[test]
fn read_stdout_line_preserves_consumed_prefix_after_cancellation() {
    const NOTIFICATION: &str = r#"{"method":"experimental/server-notification","params":{"message":"codex-mock notification"}}"#;
    const RESPONSE: &str = r#"{"id":2,"result":{"completed":true}}"#;
    const PREFIX_LEN: usize = 24;
    let transcript = format!("{NOTIFICATION}\n{RESPONSE}\n");
    let consumed = Cell::new(0);
    let mut reader = GatedStdout {
        bytes: transcript.as_bytes(),
        available: PREFIX_LEN,
        consumed: &consumed,
    };
    let mut partial_line = Vec::new();
    let mut read = Box::pin(read_stdout_line(&mut reader, &mut partial_line));
    let mut cx = Context::from_waker(Waker::noop());

    assert!(read.as_mut().poll(&mut cx).is_pending());
    // Prove consumption while the future still owns its borrows, before
    // cancellation. A Pending read on an empty pipe cannot satisfy this.
    assert_eq!(consumed.get(), PREFIX_LEN);
    drop(read);

    // No executor or wake-up race: release only after the read is dropped,
    // then manually poll the actual production helper with all bytes ready.
    reader.available = transcript.len();
    let notification = read_stdout_line(&mut reader, &mut partial_line)
        .now_or_never()
        .expect("released notification must be ready")
        .expect("read notification");
    assert_eq!(notification.as_deref(), Some(NOTIFICATION));

    let response = read_stdout_line(&mut reader, &mut partial_line)
        .now_or_never()
        .expect("following response must be ready")
        .expect("read response");
    assert_eq!(response.as_deref(), Some(RESPONSE));

    let eof = read_stdout_line(&mut reader, &mut partial_line)
        .now_or_never()
        .expect("exhausted transcript must be ready")
        .expect("read EOF");
    assert_eq!(eof, None);
}

#[test]
fn app_server_args_put_root_config_overrides_before_subcommand() {
    let args = app_server_args(&[
        r#"model_provider="openrouter-codex""#.to_string(),
        r#"model_providers.openrouter-codex.supports_websockets=false"#.to_string(),
        r#"web_search="disabled""#.to_string(),
    ]);

    let expected = [
        "-c",
        r#"model_provider="openrouter-codex""#,
        "-c",
        r#"model_providers.openrouter-codex.supports_websockets=false"#,
        "-c",
        r#"web_search="disabled""#,
        "app-server",
        "--listen",
        "stdio://",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(args, expected);
}
