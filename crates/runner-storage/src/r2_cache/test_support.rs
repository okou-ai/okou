//! A small operation-level test double for callers of the R2 cache.
//! Wire protocol tests remain in `http_transport_tests` and `http_integration`.
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use bytes::Bytes;
use futures_util::stream;
use tokio::io::AsyncRead;
use tokio_util::io::StreamReader;

use super::{
    R2Error, R2ImageCache,
    http_transport::{DownloadResponse, Part},
    transport::R2Transport,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Head,
    Get,
    Create,
    UploadPart,
    Complete,
    Abort,
}

/// Data available to a rule matcher; body contents are never copied for matching.
pub struct Request<'a> {
    pub bucket: &'a str,
    pub key: &'a str,
    pub upload_id: Option<&'a str>,
    pub part_number: Option<i32>,
    pub parts: &'a [(i32, String)],
    pub body_len: usize,
}

#[derive(Clone)]
enum Answer {
    Head(bool),
    GetBytes(Bytes, Option<i64>),
    GetReader(Arc<dyn Fn() -> Pin<Box<dyn AsyncRead + Send>> + Send + Sync>),
    GetErrorAfter(Bytes, &'static str),
    GetMissing,
    Create(Option<String>),
    UploadPart(Option<String>),
    Complete,
    Abort,
    Error(String),
}

struct RuleInner {
    operation: Operation,
    matcher: Box<dyn for<'a> Fn(&Request<'a>) -> bool + Send + Sync>,
    answers: Vec<Answer>,
    calls: AtomicUsize,
}

/// Cloneable per-operation rule. Each caller retains its own handle to assert
/// counts; all clones share one atomic count and immutable response.
#[derive(Clone)]
pub struct Rule(Arc<RuleInner>);

impl Rule {
    fn new(operation: Operation, answer: Answer) -> Self {
        Self(Arc::new(RuleInner {
            operation,
            matcher: Box::new(|_| true),
            answers: vec![answer],
            calls: AtomicUsize::new(0),
        }))
    }
    pub fn head(exists: bool) -> Self {
        Self::new(Operation::Head, Answer::Head(exists))
    }
    pub fn get(bytes: Vec<u8>) -> Self {
        Self::new(Operation::Get, Answer::GetBytes(Bytes::from(bytes), None))
    }
    pub fn get_with_content_length(bytes: Vec<u8>, length: i64) -> Self {
        Self::new(
            Operation::Get,
            Answer::GetBytes(Bytes::from(bytes), Some(length)),
        )
    }
    pub fn get_error_after(bytes: Vec<u8>, message: &'static str) -> Self {
        Self::new(
            Operation::Get,
            Answer::GetErrorAfter(Bytes::from(bytes), message),
        )
    }
    pub fn get_missing() -> Self {
        Self::new(Operation::Get, Answer::GetMissing)
    }
    pub fn get_reader(
        reader: impl Fn() -> Pin<Box<dyn AsyncRead + Send>> + Send + Sync + 'static,
    ) -> Self {
        Self::new(Operation::Get, Answer::GetReader(Arc::new(reader)))
    }
    /// Consecutive responses for one rule. The last response repeats if called again.
    pub fn then(self, next: Self) -> Self {
        assert!(
            self.0.operation == next.0.operation,
            "a rule sequence must use one operation"
        );
        let mut answers = self.0.answers.clone();
        answers.extend(next.0.answers.iter().cloned());
        Self(Arc::new(RuleInner {
            operation: self.0.operation,
            matcher: Box::new(|_| true),
            answers,
            calls: AtomicUsize::new(0),
        }))
    }
    pub fn create(id: Option<&str>) -> Self {
        Self::new(Operation::Create, Answer::Create(id.map(str::to_owned)))
    }
    pub fn upload_part(etag: Option<&str>) -> Self {
        Self::new(
            Operation::UploadPart,
            Answer::UploadPart(etag.map(str::to_owned)),
        )
    }
    pub fn complete() -> Self {
        Self::new(Operation::Complete, Answer::Complete)
    }
    pub fn abort() -> Self {
        Self::new(Operation::Abort, Answer::Abort)
    }
    pub fn fail(operation: Operation, message: &str) -> Self {
        Self::new(operation, Answer::Error(message.to_owned()))
    }
    pub fn with_matcher(
        self,
        match_request: impl for<'a> Fn(&Request<'a>) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(RuleInner {
            operation: self.0.operation,
            matcher: Box::new(match_request),
            answers: self.0.answers.clone(),
            calls: AtomicUsize::new(0),
        }))
    }
    pub fn num_calls(&self) -> usize {
        self.0.calls.load(Ordering::SeqCst)
    }
}

struct FakeTransport {
    bucket: String,
    rules: Vec<Rule>,
}

impl FakeTransport {
    fn answer(
        &self,
        operation: Operation,
        key: &str,
        id: Option<&str>,
        number: Option<i32>,
        parts: &[(i32, String)],
        body_len: usize,
    ) -> Result<Answer, R2Error> {
        let request = Request {
            bucket: &self.bucket,
            key,
            upload_id: id,
            part_number: number,
            parts,
            body_len,
        };
        let rule = self
            .rules
            .iter()
            .find(|rule| rule.0.operation == operation && (rule.0.matcher)(&request))
            .ok_or_else(|| {
                R2Error::S3(format!("unmatched test R2 operation {operation:?}: {key}"))
            })?;
        let index = rule
            .0
            .calls
            .fetch_add(1, Ordering::SeqCst)
            .min(rule.0.answers.len().saturating_sub(1));
        rule.0
            .answers
            .get(index)
            .cloned()
            .ok_or_else(|| R2Error::S3("test R2 rule has no response".into()))
    }
}

fn answer_error(answer: Answer, operation: Operation) -> R2Error {
    match answer {
        Answer::Error(message) => R2Error::S3(message),
        _ => R2Error::S3(format!("invalid test reply for {operation:?}")),
    }
}

#[async_trait::async_trait]
impl R2Transport for FakeTransport {
    async fn head(&self, key: &str) -> Result<bool, R2Error> {
        match self.answer(Operation::Head, key, None, None, &[], 0)? {
            Answer::Head(value) => Ok(value),
            other => Err(answer_error(other, Operation::Head)),
        }
    }
    async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error> {
        let answer = self.answer(Operation::Get, key, None, None, &[], 0)?;
        let response = match answer {
            Answer::GetMissing => return Ok(None),
            Answer::GetBytes(bytes, length) => {
                let body: Pin<Box<dyn AsyncRead + Send>> = Box::pin(std::io::Cursor::new(bytes));
                DownloadResponse {
                    content_length: length,
                    body,
                }
            }
            Answer::GetReader(reader) => DownloadResponse {
                content_length: None,
                body: reader(),
            },
            Answer::GetErrorAfter(bytes, message) => {
                let stream = stream::iter(vec![
                    Ok(bytes),
                    Err(io::Error::new(io::ErrorKind::ConnectionReset, message)),
                ]);
                DownloadResponse {
                    content_length: None,
                    body: Box::pin(StreamReader::new(stream)),
                }
            }
            other => return Err(answer_error(other, Operation::Get)),
        };
        Ok(Some(response))
    }
    async fn create_multipart(&self, key: &str) -> Result<String, R2Error> {
        match self.answer(Operation::Create, key, None, None, &[], 0)? {
            Answer::Create(Some(id)) => Ok(id),
            Answer::Create(None) => {
                Err(R2Error::S3("create_multipart_upload: no upload_id".into()))
            }
            other => Err(answer_error(other, Operation::Create)),
        }
    }
    async fn upload_part(
        &self,
        key: &str,
        id: &str,
        number: i32,
        chunk: Bytes,
    ) -> Result<Part, R2Error> {
        match self.answer(
            Operation::UploadPart,
            key,
            Some(id),
            Some(number),
            &[],
            chunk.len(),
        )? {
            Answer::UploadPart(Some(etag)) => Ok(Part { number, etag }),
            Answer::UploadPart(None) => Err(R2Error::S3(format!(
                "upload_part {number}: missing e_tag in response"
            ))),
            other => Err(answer_error(other, Operation::UploadPart)),
        }
    }
    async fn complete_multipart(&self, key: &str, id: &str, parts: &[Part]) -> Result<(), R2Error> {
        let parts = parts
            .iter()
            .map(|part| (part.number, part.etag.clone()))
            .collect::<Vec<_>>();
        match self.answer(Operation::Complete, key, Some(id), None, &parts, 0)? {
            Answer::Complete => Ok(()),
            other => Err(answer_error(other, Operation::Complete)),
        }
    }
    async fn abort_multipart(&self, key: &str, id: &str) -> Result<(), R2Error> {
        match self.answer(Operation::Abort, key, Some(id), None, &[], 0)? {
            Answer::Abort => Ok(()),
            other => Err(answer_error(other, Operation::Abort)),
        }
    }
}

impl R2ImageCache {
    /// Test-support entrypoint; does not instantiate AWS SDK or touch the network.
    pub fn with_test_rules(bucket: String, rules: &[&Rule]) -> Self {
        Self {
            client: Arc::new(FakeTransport {
                bucket: bucket.clone(),
                rules: rules.iter().map(|rule| (*rule).clone()).collect(),
            }),
            bucket,
        }
    }
}
