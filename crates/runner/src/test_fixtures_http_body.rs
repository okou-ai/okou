use std::{
    io,
    pin::Pin,
    task::{Context, Poll},
};

use aws_sdk_s3::primitives::ByteStream;
use bytes::Bytes;
use http_body::{Body, Frame};

pub(crate) fn byte_stream_with_error_after(bytes: Vec<u8>, error: io::Error) -> ByteStream {
    ByteStream::from_body_1_x(BodyThenError {
        bytes: Some(Bytes::from(bytes)),
        error: Some(error),
    })
}

struct BodyThenError {
    bytes: Option<Bytes>,
    error: Option<io::Error>,
}

impl Body for BodyThenError {
    type Data = Bytes;
    type Error = io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if let Some(bytes) = self.bytes.take() {
            return Poll::Ready(Some(Ok(Frame::data(bytes))));
        }
        if let Some(error) = self.error.take() {
            return Poll::Ready(Some(Err(error)));
        }
        Poll::Ready(None)
    }
}
