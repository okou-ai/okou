//! Narrow, signed R2/S3 HTTP transport for the six template-cache operations.
//!
//! The production cache uses this transport. Operation-level doubles and
//! signed-wire tests cover cache orchestration and protocol behavior.

use std::{
    io,
    pin::Pin,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicI64, Ordering},
    },
    time::{Duration, SystemTime},
};

use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{
        PayloadChecksumKind, PercentEncodingMode, SignableBody, SignableRequest, SigningParams,
        SigningSettings, UriPathNormalizationMode, sign,
    },
    sign::v4,
};
use aws_smithy_http::header as smithy_header;
use aws_smithy_runtime_api::client::identity::Identity;
use aws_smithy_types::{
    DateTime as SmithyDateTime, date_time::Format as SmithyDateFormat, primitive::Parse,
};
use base64::Engine as _;
use bytes::Bytes;
use futures_util::StreamExt;
use reqwest::{
    Client, Method, Request, Response, StatusCode,
    header::{CONTENT_TYPE, ETAG, HeaderMap},
};
use tokio::{
    io::AsyncRead,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use tokio_util::io::StreamReader;
use url::Url;

use super::R2Error;

const MAX_XML_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
// The pinned SDK protects GET response bodies against stalled downloads after
// a one-second observation window and five-second grace period. Keep the
// first-response budget at 60 seconds; this bound applies only between body
// chunks, so a stopped peer cannot pin the archive consumer for a minute.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(6);
const PART_TIMEOUT: Duration = Duration::from_secs(300);
// The original S3 client uses the standard retry policy (three attempts).
// Retain the bounded attempt count; every attempt is signed afresh.
const MAX_ATTEMPTS: usize = 3;
// The pinned SDK's standard retry bucket starts with 500 tokens. The legacy
// policy charges five for service failures and ten for transient I/O failures.
const RETRY_QUOTA: usize = 500;
// The SDK's default retry partition is `s3-auto`, shared by its clients in one
// process. R2 clients here likewise share one budget, not one per upload.
static SHARED_RETRY_QUOTA: OnceLock<Arc<Semaphore>> = OnceLock::new();

#[derive(Clone, Copy)]
enum ExpectedBody {
    Raw,
    GetMissingXml,
    CreateXml,
    CompleteXml,
}

struct TransportReply {
    response: Response,
    xml: Option<Bytes>,
}

pub(super) struct DownloadResponse {
    pub(super) content_length: Option<i64>,
    pub(super) body: Pin<Box<dyn AsyncRead + Send>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Part {
    pub(super) number: i32,
    pub(super) etag: String,
}

/// Only the credentials, bucket and fixed R2 endpoint needed by the template
/// cache. Its Debug output intentionally never includes credentials.
#[derive(Clone)]
pub(super) struct R2HttpClient {
    client: Client,
    part_client: Client,
    endpoint: Url,
    bucket: String,
    credentials: Credentials,
    // The SDK retains server clock skew across requests on the same client.
    clock_skew_ms: Arc<AtomicI64>,
    retry_quota: Arc<Semaphore>,
    retry_quota_capacity: usize,
}

impl std::fmt::Debug for R2HttpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("R2HttpClient")
            .field("bucket", &self.bucket)
            .finish_non_exhaustive()
    }
}

impl R2HttpClient {
    /// Production uses an account-scoped HTTPS endpoint; a local HTTP endpoint
    /// is permitted only by the private test constructor in this module.
    pub(super) fn new(
        account_id: &str,
        bucket: String,
        access_key: String,
        secret_key: String,
    ) -> Result<Self, R2Error> {
        if account_id.is_empty()
            || !account_id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            return Err(R2Error::S3("invalid R2 account id".into()));
        }
        let endpoint = Url::parse(&format!("https://{account_id}.r2.cloudflarestorage.com"))
            .map_err(|e| R2Error::S3(format!("invalid R2 endpoint: {e}")))?;
        Self::with_endpoint(endpoint, bucket, access_key, secret_key)
    }

    #[cfg(test)]
    pub(crate) fn with_test_endpoint(endpoint: Url, bucket: String) -> Result<Self, R2Error> {
        Self::with_endpoint(
            endpoint,
            bucket,
            "AKIDEXAMPLE".into(),
            "not-a-real-secret".into(),
        )
    }

    #[cfg(test)]
    pub(crate) fn with_test_endpoint_timeouts(
        endpoint: Url,
        bucket: String,
        control: Duration,
        part: Duration,
    ) -> Result<Self, R2Error> {
        let mut client = Self::with_test_endpoint(endpoint, bucket)?;
        client.client = Self::make_client(control)?;
        client.part_client = Self::make_client(part)?;
        Ok(client)
    }

    #[cfg(test)]
    pub(crate) fn with_test_endpoint_retry_quota(
        endpoint: Url,
        bucket: String,
        quota: usize,
    ) -> Result<Self, R2Error> {
        let mut client = Self::with_test_endpoint(endpoint, bucket)?;
        client.retry_quota = Arc::new(Semaphore::new(quota));
        client.retry_quota_capacity = quota;
        Ok(client)
    }

    fn make_client(read_timeout: Duration) -> Result<Client, R2Error> {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(read_timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| R2Error::S3(format!("create R2 client: {e}")))
    }

    fn with_endpoint(
        endpoint: Url,
        bucket: String,
        access_key: String,
        secret_key: String,
    ) -> Result<Self, R2Error> {
        if bucket.is_empty()
            || bucket == "."
            || bucket == ".."
            || bucket.contains('/')
            || bucket.contains('?')
            || bucket.contains('#')
        {
            return Err(R2Error::S3("invalid R2 bucket name".into()));
        }
        let client = Self::make_client(READ_TIMEOUT)?;
        let part_client = Self::make_client(PART_TIMEOUT)?;
        Ok(Self {
            client,
            part_client,
            endpoint,
            bucket,
            credentials: Credentials::new(access_key, secret_key, None, None, "r2-env"),
            clock_skew_ms: Arc::new(AtomicI64::new(0)),
            retry_quota: SHARED_RETRY_QUOTA
                .get_or_init(|| Arc::new(Semaphore::new(RETRY_QUOTA)))
                .clone(),
            retry_quota_capacity: RETRY_QUOTA,
        })
    }

    fn url(&self, key: &str, query: &[(&str, &str)]) -> Result<Url, R2Error> {
        let mut url = self.endpoint.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|()| R2Error::S3("R2 endpoint cannot have path segments".into()))?;
            segments.clear().push(&self.bucket);
            for segment in key.split('/') {
                if segment.is_empty() || segment == "." || segment == ".." {
                    return Err(R2Error::S3("invalid R2 object key".into()));
                }
                segments.push(segment);
            }
        }
        if query == [("uploads", "")] {
            // The SDK serializes this S3 subresource as `?uploads`, not
            // `?uploads=`. Both canonicalize as `uploads=` for SigV4.
            url.set_query(Some("uploads"));
        } else if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (name, value) in query {
                pairs.append_pair(name, value);
            }
        }
        Ok(url)
    }

    fn signed_request(
        &self,
        method: Method,
        url: Url,
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<Request, R2Error> {
        let client = if method == Method::PUT {
            &self.part_client
        } else {
            &self.client
        };
        let mut builder = client.request(method.clone(), url);
        if method == Method::PUT {
            // The SDK's UploadPart interceptor defaults to CRC32. Keep the
            // part-level checksum in addition to the SigV4 payload hash.
            let checksum = base64::engine::general_purpose::STANDARD
                .encode(crc32fast::hash(&body).to_be_bytes());
            // Match the SDK's per-part read timeout, not a 300-second
            // whole-request deadline: an active transfer can take longer.
            builder = builder
                .header("x-amz-sdk-checksum-algorithm", "CRC32")
                .header("x-amz-checksum-crc32", checksum)
                // The generated UploadPart serializer supplies this default
                // for the byte-stream body, unlike the other five operations.
                .header(CONTENT_TYPE, "application/octet-stream");
        }
        if let Some(content_type) = content_type {
            builder = builder.header(CONTENT_TYPE, content_type);
        }
        if !body.is_empty() {
            // The SDK signs Content-Length for known, nonempty Bytes bodies.
            // Letting reqwest add it only after signing changes SignedHeaders.
            builder = builder.header(reqwest::header::CONTENT_LENGTH, body.len().to_string());
        }
        let mut request = builder
            .body(body)
            .build()
            .map_err(|e| R2Error::S3(format!("build R2 request: {e}")))?;
        let identity: Identity = self.credentials.clone().into();
        let mut settings = SigningSettings::default();
        settings.percent_encoding_mode = PercentEncodingMode::Single;
        settings.uri_path_normalization_mode = UriPathNormalizationMode::Disabled;
        settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
        let params: SigningParams<'_> = v4::SigningParams::builder()
            .identity(&identity)
            .region("auto")
            .name("s3")
            .time(adjust_signing_time(
                SystemTime::now(),
                self.clock_skew_ms.load(Ordering::Relaxed),
            ))
            .settings(settings)
            .build()
            .map_err(|e| R2Error::S3(format!("build R2 signing parameters: {e}")))?
            .into();
        let method = request.method().as_str().to_owned();
        let url = request.url().as_str().to_owned();
        let headers = request
            .headers()
            .iter()
            .map(|(k, v)| (k.as_str().to_owned(), v.to_str().map(str::to_owned)))
            .map(|(k, v)| {
                v.map(|v| (k, v))
                    .map_err(|e| R2Error::S3(format!("invalid R2 header: {e}")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        // Every operation here supplies Bytes. Never sign an empty fallback
        // if a future change accidentally introduces a streaming request body.
        let payload = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .ok_or_else(|| R2Error::S3("R2 request body is not replayable bytes".into()))?;
        let signable = SignableRequest::new(
            &method,
            &url,
            headers.iter().map(|(k, v)| (k.as_str(), v.as_str())),
            SignableBody::Bytes(payload),
        )
        .map_err(|e| R2Error::S3(format!("invalid R2 request for signing: {e}")))?;
        let (instructions, _) = sign(signable, &params)
            .map_err(|e| R2Error::S3(format!("sign R2 request: {e}")))?
            .into_parts();
        let (signed_headers, signed_query) = instructions.into_parts();
        if !signed_query.is_empty() {
            return Err(R2Error::S3("unexpected R2 query signing".into()));
        }
        for header in signed_headers {
            let value = reqwest::header::HeaderValue::from_str(header.value())
                .map_err(|e| R2Error::S3(format!("invalid signature header: {e}")))?;
            request.headers_mut().insert(header.name(), value);
        }
        Ok(request)
    }

    // Acquire without waiting: depleted SDK retry quota returns the original
    // error. A previous retry's quota is spent when another retry is reserved;
    // the most recent permit is returned on success or cancellation.
    fn reserve_retry(&self, permit: &mut Option<OwnedSemaphorePermit>, cost: u32) -> bool {
        let Ok(next) = self.retry_quota.clone().try_acquire_many_owned(cost) else {
            return false;
        };
        if let Some(previous) = permit.replace(next) {
            previous.forget();
        }
        true
    }

    fn reward_success(&self, permit: &mut Option<OwnedSemaphorePermit>) {
        if let Some(permit) = permit.take() {
            drop(permit);
        } else if self.retry_quota.available_permits() < self.retry_quota_capacity {
            // The standard policy regenerates one token on first-try success.
            self.retry_quota.add_permits(1);
        }
    }

    async fn execute(
        &self,
        method: Method,
        key: &str,
        query: &[(&str, &str)],
        body: Bytes,
        content_type: Option<&str>,
        expected: ExpectedBody,
    ) -> Result<TransportReply, R2Error> {
        let url = self.url(key, query)?;
        let client = if method == Method::PUT {
            &self.part_client
        } else {
            &self.client
        };
        let mut retry_permit = None;
        for attempt in 1..=MAX_ATTEMPTS {
            // Request bodies are Bytes, so retries replay the identical payload;
            // fresh SigV4 timestamps and headers are generated on every attempt.
            let request =
                self.signed_request(method.clone(), url.clone(), body.clone(), content_type)?;
            let sent = SystemTime::now();
            let mut response = match client.execute(request).await {
                Ok(response) => response,
                Err(e) => {
                    if attempt < MAX_ATTEMPTS
                        && retryable_transport(&e)
                        && self.reserve_retry(&mut retry_permit, 10)
                    {
                        retry_delay(attempt, None).await;
                        continue;
                    }
                    return Err(if e.is_timeout() {
                        R2Error::S3(format!("R2 request timeout: {e}"))
                    } else {
                        R2Error::S3(format!("R2 request failed: {e}"))
                    });
                }
            };
            let measured_skew = measure_clock_skew(&response, sent, SystemTime::now());
            if let Some(skew_ms) = measured_skew {
                self.clock_skew_ms.store(skew_ms, Ordering::Relaxed);
            }
            let status = response.status();
            // The SDK interprets x-amz-retry-after as milliseconds, capped by
            // the standard policy's maximum backoff.
            let retry_after = response
                .headers()
                .get("x-amz-retry-after")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map(|ms| Duration::from_millis(ms).min(Duration::from_secs(20)));
            // A HEAD 404 has no usable XML body in the SDK and is a cache
            // miss. Other 404s must go through error-code classification:
            // even a 404 can carry a retryable S3 code such as SlowDown.
            if status == StatusCode::NOT_FOUND && method == Method::HEAD {
                return Ok(TransportReply {
                    response,
                    xml: None,
                });
            }
            let xml_output = matches!(
                expected,
                ExpectedBody::CreateXml | ExpectedBody::CompleteXml
            );
            if status.is_success()
                && (xml_output || method == Method::PUT || method == Method::DELETE)
            {
                // The SDK buffers all non-streaming successful responses and
                // checks their XML root for <Error>, not just Complete. A part
                // can even include an ETag yet fail with HTTP 200 InternalError.
                // Keep the normal XML and unexpected raw-response reads bounded.
                let max = if xml_output {
                    MAX_XML_BYTES
                } else {
                    MAX_ERROR_BYTES
                };
                let body = match bounded_bytes(&mut response, max).await {
                    Ok(body) => body,
                    Err(BodyReadError::Transport(e))
                        if attempt < MAX_ATTEMPTS
                            && retryable_transport(&e)
                            && self.reserve_retry(&mut retry_permit, 10) =>
                    {
                        retry_delay(attempt, retry_after).await;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                if body.is_empty() && !xml_output {
                    validate_success_headers(&method, expected, response.headers())?;
                    self.reward_success(&mut retry_permit);
                    return Ok(TransportReply {
                        response,
                        xml: None,
                    });
                }
                let document = parse_xml(&body);
                if document.is_err() && has_error_root_prefix(&body) {
                    // Smithy recognizes the Error start element before its
                    // full error decoder fails. That response error consumes
                    // the transient I/O retry cost, even for HTTP 200.
                    if attempt < MAX_ATTEMPTS && self.reserve_retry(&mut retry_permit, 10) {
                        retry_delay(attempt, retry_after).await;
                        continue;
                    }
                    return Err(R2Error::S3(format!(
                        "R2 request: HTTP {status} malformed embedded error"
                    )));
                }
                if document
                    .as_ref()
                    .is_ok_and(|doc| doc.root_element().tag_name().name() == "Error")
                {
                    let code = xml_code(&body);
                    if attempt < MAX_ATTEMPTS
                        && is_retryable(status, code.as_deref(), measured_skew)
                        && self
                            .reserve_retry(&mut retry_permit, retry_cost(status, code.as_deref()))
                    {
                        retry_delay(attempt, retry_after).await;
                        continue;
                    }
                    return Err(R2Error::S3(format!(
                        "R2 request: HTTP {status} embedded error {}",
                        code.as_deref().unwrap_or("unknown")
                    )));
                }
                if xml_output {
                    let document = document?;
                    if matches!(expected, ExpectedBody::CompleteXml) {
                        if document.root_element().tag_name().name()
                            != "CompleteMultipartUploadResult"
                        {
                            return Err(R2Error::S3(
                                "complete_multipart_upload: unexpected response unknown".into(),
                            ));
                        }
                        validate_complete_fields(document.root_element())?;
                    } else if matches!(expected, ExpectedBody::CreateXml) {
                        if document.root_element().tag_name().name()
                            != "InitiateMultipartUploadResult"
                        {
                            return Err(R2Error::S3(
                                "unexpected CreateMultipartUpload response".into(),
                            ));
                        }
                        validate_create_fields(document.root_element())?;
                    }
                }
                validate_success_headers(&method, expected, response.headers())?;
                self.reward_success(&mut retry_permit);
                return Ok(TransportReply {
                    response,
                    xml: xml_output.then_some(body),
                });
            }
            if !status.is_success() {
                let body = match bounded_bytes(&mut response, MAX_ERROR_BYTES).await {
                    Ok(body) => body,
                    // SDK's status classifier still retries 500/502/503/504
                    // when the error body is too large or fails to deserialize.
                    Err(BodyReadError::TooLarge)
                        if attempt < MAX_ATTEMPTS
                            && is_retryable(status, None, measured_skew)
                            && self.reserve_retry(&mut retry_permit, retry_cost(status, None)) =>
                    {
                        retry_delay(attempt, retry_after).await;
                        continue;
                    }
                    Err(BodyReadError::Transport(e))
                        if attempt < MAX_ATTEMPTS
                            && (retryable_transport(&e)
                                || is_retryable(status, None, measured_skew))
                            && self.reserve_retry(
                                &mut retry_permit,
                                if retryable_transport(&e) {
                                    10
                                } else {
                                    retry_cost(status, None)
                                },
                            ) =>
                    {
                        retry_delay(attempt, retry_after).await;
                        continue;
                    }
                    Err(error) => return Err(error.into()),
                };
                let code = xml_code(&body);
                if attempt < MAX_ATTEMPTS
                    && is_retryable(status, code.as_deref(), measured_skew)
                    && self.reserve_retry(&mut retry_permit, retry_cost(status, code.as_deref()))
                {
                    retry_delay(attempt, retry_after).await;
                    continue;
                }
                // The SDK models NoSuchKey by XML error code, not by HTTP
                // status: even a 400 or 403 carrying that exact code is a
                // cache miss. Do not infer a miss from status alone.
                if matches!(expected, ExpectedBody::GetMissingXml)
                    && code.as_deref() == Some("NoSuchKey")
                    && parse_xml(&body)
                        .ok()
                        .is_some_and(|doc| doc.root_element().tag_name().name() == "Error")
                {
                    return Ok(TransportReply {
                        response,
                        xml: Some(body),
                    });
                }
                return Err(R2Error::S3(format!(
                    "R2 request: HTTP {status}, code {}",
                    code.as_deref().unwrap_or("unknown")
                )));
            }
            validate_success_headers(&method, expected, response.headers())?;
            self.reward_success(&mut retry_permit);
            return Ok(TransportReply {
                response,
                xml: None,
            });
        }
        Err(R2Error::S3(
            "R2 retry loop exhausted without a response".into(),
        ))
    }

    pub(super) async fn head(&self, key: &str) -> Result<bool, R2Error> {
        let response = self
            .execute(
                Method::HEAD,
                key,
                &[],
                Bytes::new(),
                None,
                ExpectedBody::Raw,
            )
            .await?
            .response;
        if response.status().is_success() {
            Ok(true)
        } else if response.status() == StatusCode::NOT_FOUND {
            Ok(false)
        } else {
            Err(status_error("head_object", response).await)
        }
    }

    pub(super) async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error> {
        let TransportReply { response, xml } = self
            .execute(
                Method::GET,
                key,
                &[("x-id", "GetObject")],
                Bytes::new(),
                None,
                ExpectedBody::GetMissingXml,
            )
            .await?;
        if !response.status().is_success() {
            if xml.as_deref().and_then(xml_code).as_deref() == Some("NoSuchKey") {
                return Ok(None);
            }
            return Err(status_error("get_object", response).await);
        }
        let content_length = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok());
        // HTTP 204 forbids a body. The pinned SDK surfaces a read failure if
        // a GET nevertheless advertises nonzero bytes; reqwest silently drops
        // the body, which would misclassify the truncated archive as corrupt.
        if response.status() == StatusCode::NO_CONTENT && content_length.is_some_and(|n| n > 0) {
            return Err(R2Error::S3(
                "get_object: HTTP 204 advertised a non-empty body".into(),
            ));
        }
        // SDK downloads fail a stalled response body independently of the
        // request's 60-second first-response timeout. Do not retry a body
        // after returning it: its consumer may already have unpacked bytes.
        let stream = futures_util::stream::unfold(
            Some(Box::pin(response.bytes_stream())),
            |state| async move {
                let mut stream = state?;
                match tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, stream.as_mut().next()).await {
                    Ok(Some(Ok(bytes))) => Some((Ok(bytes), Some(stream))),
                    Ok(Some(Err(error))) => Some((Err(io::Error::other(error)), None)),
                    Ok(None) => None,
                    Err(_) => Some((
                        Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "R2 download body stalled",
                        )),
                        None,
                    )),
                }
            },
        );
        Ok(Some(DownloadResponse {
            content_length,
            body: Box::pin(StreamReader::new(stream)),
        }))
    }

    pub(super) async fn create_multipart(&self, key: &str) -> Result<String, R2Error> {
        let TransportReply { response, xml } = self
            .execute(
                Method::POST,
                key,
                &[("uploads", "")],
                Bytes::new(),
                None,
                ExpectedBody::CreateXml,
            )
            .await?;
        if !response.status().is_success() {
            return Err(status_error("create_multipart_upload", response).await);
        }
        let body = xml.ok_or_else(|| R2Error::S3("missing CreateMultipartUpload XML".into()))?;
        // execute validated the SDK-modeled Create XML before rewarding a
        // successful request; only the cache-specific UploadId requirement is
        // checked here (the SDK output builder itself permits its absence).
        let document = parse_xml(&body)?;
        document
            .root_element()
            .children()
            .rfind(|n| n.is_element() && n.tag_name().name() == "UploadId")
            .and_then(|n| n.text())
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| R2Error::S3("create_multipart_upload: no upload_id".into()))
    }

    pub(super) async fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        number: i32,
        chunk: Bytes,
    ) -> Result<Part, R2Error> {
        let pn = number.to_string();
        let response = self
            .execute(
                Method::PUT,
                key,
                &[
                    ("x-id", "UploadPart"),
                    ("partNumber", &pn),
                    ("uploadId", upload_id),
                ],
                chunk,
                None,
                ExpectedBody::Raw,
            )
            .await?
            .response;
        if !response.status().is_success() {
            return Err(status_error("upload_part", response).await);
        }
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|v| v.to_str().ok())
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| {
                R2Error::S3(format!("upload_part {number}: missing e_tag in response"))
            })?;
        Ok(Part {
            number,
            etag: etag.to_owned(),
        })
    }

    pub(super) async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[Part],
    ) -> Result<(), R2Error> {
        // Match the SDK's REST-XML namespace, rather than relying on R2
        // accepting an unqualified CompleteMultipartUpload payload.
        let mut xml = String::from(
            "<CompleteMultipartUpload xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        for part in parts {
            // Match the generated CompletedPart serializer's element order.
            xml.push_str("<Part><ETag>");
            xml.push_str(&xml_escape(&part.etag));
            xml.push_str("</ETag><PartNumber>");
            xml.push_str(&part.number.to_string());
            xml.push_str("</PartNumber></Part>");
        }
        xml.push_str("</CompleteMultipartUpload>");
        let response = self
            .execute(
                Method::POST,
                key,
                &[("uploadId", upload_id)],
                Bytes::from(xml),
                Some("application/xml"),
                ExpectedBody::CompleteXml,
            )
            .await?
            .response;
        if !response.status().is_success() {
            return Err(status_error("complete_multipart_upload", response).await);
        }
        // execute validated the entire XML body, including HTTP 200 errors.
        Ok(())
    }

    pub(super) async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), R2Error> {
        let response = self
            .execute(
                Method::DELETE,
                key,
                &[("x-id", "AbortMultipartUpload"), ("uploadId", upload_id)],
                Bytes::new(),
                None,
                ExpectedBody::Raw,
            )
            .await?
            .response;
        if !response.status().is_success() {
            return Err(status_error("abort_multipart_upload", response).await);
        }
        Ok(())
    }
}

// The generated SDK response deserializers reject malformed or repeated
// modeled headers even when the cache only consumes existence, body, or ETag.
// Mirror the six output header shapes before rewarding a retry or disarming
// the multipart guard; this includes object metadata's header prefix.
fn validate_success_headers(
    method: &Method,
    expected: ExpectedBody,
    headers: &HeaderMap,
) -> Result<(), R2Error> {
    let object = *method == Method::HEAD || matches!(expected, ExpectedBody::GetMissingXml);
    let part = *method == Method::PUT;
    let abort = *method == Method::DELETE;
    if object {
        validate_primitive_header::<i64>(headers, "content-length")?;
        for name in [
            "x-amz-missing-meta",
            "x-amz-object-lock-event-hold-duration-days",
            "x-amz-object-lock-event-hold-duration-years",
            "x-amz-mp-parts-count",
            "x-amz-tagging-count",
        ] {
            validate_primitive_header::<i32>(headers, name)?;
        }
        validate_primitive_header::<bool>(headers, "x-amz-delete-marker")?;
        for name in ["expires", "last-modified"] {
            validate_date_header(headers, name, SmithyDateFormat::HttpDate)?;
        }
        validate_date_header(
            headers,
            "x-amz-object-lock-retain-until-date",
            SmithyDateFormat::DateTimeWithOffset,
        )?;
        for name in [
            "accept-ranges",
            "cache-control",
            "content-disposition",
            "content-encoding",
            "content-language",
            "content-range",
            "content-type",
            "etag",
            "expiresstring",
            "x-amz-checksum-crc32",
            "x-amz-checksum-crc32c",
            "x-amz-checksum-crc64nvme",
            "x-amz-checksum-md5",
            "x-amz-checksum-sha1",
            "x-amz-checksum-sha256",
            "x-amz-checksum-sha512",
            "x-amz-checksum-type",
            "x-amz-checksum-xxhash128",
            "x-amz-checksum-xxhash3",
            "x-amz-checksum-xxhash64",
            "x-amz-expiration",
            "x-amz-object-lock-event-hold",
            "x-amz-object-lock-legal-hold",
            "x-amz-object-lock-mode",
            "x-amz-replication-status",
            "x-amz-request-charged",
            "x-amz-restore",
            "x-amz-server-side-encryption-customer-algorithm",
            "x-amz-server-side-encryption-customer-key-md5",
            "x-amz-server-side-encryption-aws-kms-key-id",
            "x-amz-server-side-encryption",
            "x-amz-storage-class",
            "x-amz-version-id",
            "x-amz-website-redirect-location",
        ] {
            validate_single_header(headers, name)?;
        }
        if *method == Method::HEAD {
            validate_single_header(headers, "x-amz-archive-status")?;
        }
        for name in headers
            .keys()
            .filter(|name| name.as_str().starts_with("x-amz-meta-"))
        {
            validate_single_header(headers, name.as_str())?;
        }
    }
    if !abort {
        validate_primitive_header::<bool>(
            headers,
            "x-amz-server-side-encryption-bucket-key-enabled",
        )?;
    }
    match expected {
        ExpectedBody::CreateXml => {
            validate_date_header(headers, "x-amz-abort-date", SmithyDateFormat::HttpDate)?;
            for name in [
                "x-amz-abort-rule-id",
                "x-amz-checksum-algorithm",
                "x-amz-checksum-type",
                "x-amz-request-charged",
                "x-amz-server-side-encryption-customer-algorithm",
                "x-amz-server-side-encryption-customer-key-md5",
                "x-amz-server-side-encryption-context",
                "x-amz-server-side-encryption-aws-kms-key-id",
                "x-amz-server-side-encryption",
            ] {
                validate_single_header(headers, name)?;
            }
        }
        ExpectedBody::CompleteXml => {
            for name in [
                "x-amz-expiration",
                "x-amz-request-charged",
                "x-amz-server-side-encryption-aws-kms-key-id",
                "x-amz-server-side-encryption",
                "x-amz-version-id",
            ] {
                validate_single_header(headers, name)?;
            }
        }
        ExpectedBody::Raw if part => {
            for name in [
                "etag",
                "x-amz-checksum-crc32",
                "x-amz-checksum-crc32c",
                "x-amz-checksum-crc64nvme",
                "x-amz-checksum-md5",
                "x-amz-checksum-sha1",
                "x-amz-checksum-sha256",
                "x-amz-checksum-sha512",
                "x-amz-checksum-xxhash128",
                "x-amz-checksum-xxhash3",
                "x-amz-checksum-xxhash64",
                "x-amz-request-charged",
                "x-amz-server-side-encryption-customer-algorithm",
                "x-amz-server-side-encryption-customer-key-md5",
                "x-amz-server-side-encryption-aws-kms-key-id",
                "x-amz-server-side-encryption",
            ] {
                validate_single_header(headers, name)?;
            }
        }
        ExpectedBody::Raw if abort => {
            validate_single_header(headers, "x-amz-request-charged")?;
        }
        ExpectedBody::Raw | ExpectedBody::GetMissingXml => {}
    }
    Ok(())
}

fn header_error(name: &str) -> R2Error {
    R2Error::S3(format!("invalid R2 {name} response header"))
}

fn validate_single_header(headers: &HeaderMap, name: &str) -> Result<(), R2Error> {
    smithy_header::one_or_none_bytes::<String>(headers.get_all(name).iter().map(|v| v.as_bytes()))
        .map(|_| ())
        .map_err(|_| header_error(name))
}

fn validate_primitive_header<T: Parse>(headers: &HeaderMap, name: &str) -> Result<(), R2Error> {
    let values = smithy_header::read_many_primitive_bytes::<T>(
        headers.get_all(name).iter().map(|v| v.as_bytes()),
    )
    .map_err(|_| header_error(name))?;
    if values.len() > 1 {
        return Err(header_error(name));
    }
    Ok(())
}

fn validate_date_header(
    headers: &HeaderMap,
    name: &str,
    format: SmithyDateFormat,
) -> Result<(), R2Error> {
    let values =
        smithy_header::many_dates_bytes(headers.get_all(name).iter().map(|v| v.as_bytes()), format)
            .map_err(|_| header_error(name))?;
    if values.len() > 1 {
        return Err(header_error(name));
    }
    Ok(())
}

fn adjust_signing_time(now: SystemTime, skew_ms: i64) -> SystemTime {
    let shifted = if skew_ms >= 0 {
        now.checked_add(Duration::from_millis(skew_ms as u64))
    } else {
        now.checked_sub(Duration::from_millis(skew_ms.unsigned_abs()))
    };
    shifted.unwrap_or(now)
}

// Match the SDK's response-Date midpoint measurement. Cached responses, an
// invalid Date, and round trips over 15 minutes cannot authorize a skew retry.
fn measure_clock_skew(response: &Response, sent: SystemTime, received: SystemTime) -> Option<i64> {
    if response.headers().contains_key(reqwest::header::AGE) {
        return None;
    }
    let elapsed = received.duration_since(sent).ok()?;
    if elapsed > Duration::from_secs(15 * 60) {
        return None;
    }
    let date = response
        .headers()
        .get(reqwest::header::DATE)?
        .to_str()
        .ok()?;
    // Use the same HttpDate parser as aws-runtime's service_clock_skew:
    // RFC 2822 accepts numeric offsets that the SDK rejects and misses
    // Smithy's supported subsecond IMF-fixdate responses.
    let server =
        SystemTime::try_from(SmithyDateTime::from_str(date, SmithyDateFormat::HttpDate).ok()?)
            .ok()?;
    let midpoint = sent.checked_add(elapsed / 2)?;
    match server.duration_since(midpoint) {
        Ok(delta) => i64::try_from(delta.as_millis()).ok(),
        Err(error) => i64::try_from(error.duration().as_millis())
            .ok()?
            .checked_neg(),
    }
}

fn retryable_transport(error: &reqwest::Error) -> bool {
    error.is_timeout()
        || error.is_connect()
        || error.is_request()
        || error.is_body()
        || error.is_decode()
}

fn retry_cost(status: StatusCode, code: Option<&str>) -> u32 {
    // The SDK's AWS error-code classifier takes priority over the generic
    // status classifier: throttling uses five tokens even on HTTP 503.
    if is_throttling_code(code) {
        return 5;
    }
    if matches!(
        code,
        Some("InternalError" | "RequestTimeout" | "RequestTimeoutException")
    ) || matches!(status.as_u16(), 500 | 502 | 503 | 504)
    {
        10
    } else {
        5
    }
}

fn is_throttling_code(code: Option<&str>) -> bool {
    matches!(
        code,
        Some(
            "Throttling"
                | "ThrottlingException"
                | "ThrottledException"
                | "RequestThrottledException"
                | "TooManyRequestsException"
                | "ProvisionedThroughputExceededException"
                | "TransactionInProgressException"
                | "RequestLimitExceeded"
                | "BandwidthLimitExceeded"
                | "LimitExceededException"
                | "RequestThrottled"
                | "SlowDown"
                | "PriorRequestNotComplete"
                | "EC2ThrottledException"
        )
    )
}

// Narrow equivalent of the S3 standard policy's status and AWS error-code
// classifiers for the operations used by the template cache. Do not retry
// missing objects, invalid parts, authentication failures, or malformed XML.
fn is_retryable(status: StatusCode, code: Option<&str>, skew_ms: Option<i64>) -> bool {
    matches!(status.as_u16(), 500 | 502 | 503 | 504)
        || (skew_ms.is_some_and(|ms| ms.unsigned_abs() > 4 * 60 * 1000)
            && matches!(
                code,
                Some(
                    "InvalidSignatureException"
                        | "SignatureDoesNotMatch"
                        | "AuthFailure"
                        | "RequestTimeTooSkewed"
                        | "AccessDeniedException"
                )
            ))
        || matches!(
            code,
            Some("InternalError" | "RequestTimeout" | "RequestTimeoutException")
        )
        || is_throttling_code(code)
}

async fn retry_delay(attempt: usize, retry_after: Option<Duration>) {
    if let Some(retry_after) = retry_after {
        tokio::time::sleep(retry_after).await;
        return;
    }
    // The pinned standard policy uses fastrand full jitter over exponential
    // backoff (1s for the first retry, 2s for the second). This non-crypto
    // randomness is only for the delay, never for signing.
    let backoff = Duration::from_secs(1 << (attempt - 1));
    tokio::time::sleep(backoff.mul_f64(fastrand::f64())).await;
}

fn validate_create_fields(root: roxmltree::Node<'_, '_>) -> Result<(), R2Error> {
    // A malformed Bucket or Key is a service error in the SDK even though
    // this cache only consumes UploadId. Do not begin an upload in that case.
    validate_xml_scalar_fields(
        root,
        &["UploadId", "Bucket", "Key"],
        "create_multipart_upload",
    )
}

fn validate_complete_fields(root: roxmltree::Node<'_, '_>) -> Result<(), R2Error> {
    // An element-only known scalar is a deserialization failure in the SDK,
    // not a successful Complete that may disarm the Abort guard.
    validate_xml_scalar_fields(
        root,
        &[
            "ETag",
            "Location",
            "Bucket",
            "Key",
            "ChecksumCRC32",
            "ChecksumCRC32C",
            "ChecksumCRC64NVME",
            "ChecksumSHA1",
            "ChecksumSHA256",
            "ChecksumSHA512",
            "ChecksumType",
            "ChecksumMD5",
            "ChecksumXXHASH3",
            "ChecksumXXHASH64",
            "ChecksumXXHASH128",
        ],
        "complete_multipart_upload",
    )
}

fn validate_xml_scalar_fields(
    root: roxmltree::Node<'_, '_>,
    names: &[&str],
    operation: &str,
) -> Result<(), R2Error> {
    for field in root.children().filter(|node| node.is_element()) {
        if names.contains(&field.tag_name().name())
            && field.text().is_none()
            && field.children().any(|node| node.is_element())
        {
            return Err(R2Error::S3(format!(
                "{operation}: invalid {} field",
                field.tag_name().name()
            )));
        }
    }
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn parse_xml(body: &[u8]) -> Result<roxmltree::Document<'_>, R2Error> {
    let text = std::str::from_utf8(body)
        .map_err(|e| R2Error::S3(format!("invalid R2 XML encoding: {e}")))?;
    roxmltree::Document::parse(text)
        .map_err(|e| R2Error::S3(format!("invalid R2 XML response: {e}")))
}

// Smithy's nonstreaming UploadPart/Abort decoder can recognize a leading
// <Error> start element even if the remainder is malformed XML. Its error
// decoder then fails, rather than turning HTTP 200 into success. roxmltree
// validates the whole document, so retain this narrow root-prefix check for
// malformed bodies without changing the parser used for modeled fields.
fn has_error_root_prefix(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();
    loop {
        if let Some(tail) = rest.strip_prefix("<!--") {
            let Some((_, after)) = tail.split_once("-->") else {
                return false;
            };
            rest = after.trim_start();
        } else if let Some(tail) = rest.strip_prefix("<?") {
            let Some((_, after)) = tail.split_once("?>") else {
                return false;
            };
            rest = after.trim_start();
        } else {
            break;
        }
    }
    let Some(root) = rest.strip_prefix('<') else {
        return false;
    };
    let Some(end) = root.find(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/') else {
        return false;
    };
    root[..end].rsplit(':').next() == Some("Error")
}

fn xml_code(body: &[u8]) -> Option<String> {
    let doc = parse_xml(body).ok()?;
    // The SDK's generic REST-XML error metadata reads Code and Message from
    // any root (so a SlowDown under ErrorResponse can still be retried).
    // A modeled GetObject NoSuchKey additionally requires the Error root.
    // SDK parse_error_metadata reads all direct Code and Message elements,
    // failing if a modeled scalar begins with a nested element. A malformed
    // Message must not turn NoSuchKey into a cache miss. Repeated Code fields
    // overwrite the builder, so the last value determines classification.
    let mut code = None;
    for field in doc.root_element().children().filter(|n| n.is_element()) {
        if matches!(field.tag_name().name(), "Code" | "Message") {
            if field.text().is_none() && field.children().any(|n| n.is_element()) {
                return None;
            }
            if field.tag_name().name() == "Code" {
                code = Some(field.text().unwrap_or("").to_owned());
            }
        }
    }
    code
}

enum BodyReadError {
    Transport(reqwest::Error),
    TooLarge,
}

impl From<BodyReadError> for R2Error {
    fn from(error: BodyReadError) -> Self {
        match error {
            BodyReadError::Transport(e) => Self::S3(format!("read R2 response: {e}")),
            BodyReadError::TooLarge => Self::S3("R2 XML response exceeds size limit".into()),
        }
    }
}

async fn bounded_bytes(response: &mut Response, max: usize) -> Result<Bytes, BodyReadError> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(BodyReadError::Transport)? {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|len| len > max)
        {
            return Err(BodyReadError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(bytes))
}

async fn status_error(operation: &str, mut response: Response) -> R2Error {
    let status = response.status();
    let body = bounded_bytes(&mut response, MAX_ERROR_BYTES).await;
    let code = body.as_ref().ok().and_then(|body| xml_code(body));
    R2Error::S3(format!(
        "{operation}: HTTP {status}, code {}",
        code.as_deref().unwrap_or("unknown")
    ))
}

#[cfg(test)]
mod wire_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_etags_are_escaped() {
        assert_eq!(xml_escape("\"a<&'\""), "&quot;a&lt;&amp;&apos;&quot;");
    }

    #[test]
    fn embedded_complete_error_is_not_success_shape() {
        let error = br#"<Error><Code>InvalidPart</Code></Error>"#;
        assert_eq!(xml_code(error).as_deref(), Some("InvalidPart"));
        assert_ne!(
            parse_xml(error).unwrap().root_element().tag_name().name(),
            "CompleteMultipartUploadResult"
        );
    }
}
