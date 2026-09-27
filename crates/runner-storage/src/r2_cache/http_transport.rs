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
use aws_smithy_runtime_api::client::identity::Identity;
use base64::Engine as _;
use bytes::Bytes;
use futures_util::TryStreamExt;
use reqwest::{
    Client, Method, Request, Response, StatusCode,
    header::{CONTENT_TYPE, ETAG},
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
        if !query.is_empty() {
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
            builder = builder
                .header("x-amz-sdk-checksum-algorithm", "CRC32")
                .header("x-amz-checksum-crc32", checksum)
                .timeout(PART_TIMEOUT);
        }
        if let Some(content_type) = content_type {
            builder = builder.header(CONTENT_TYPE, content_type);
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
            // HEAD 404 is a cache miss; GET 404 needs its XML body to
            // distinguish NoSuchKey from NoSuchBucket. Read and retry inside
            // the same attempt budget as the signed request.
            if status == StatusCode::NOT_FOUND {
                let xml = if matches!(expected, ExpectedBody::GetMissingXml) {
                    match bounded_bytes(&mut response, MAX_ERROR_BYTES).await {
                        Ok(body) => Some(body),
                        Err(BodyReadError::Transport(e))
                            if attempt < MAX_ATTEMPTS
                                && retryable_transport(&e)
                                && self.reserve_retry(&mut retry_permit, 10) =>
                        {
                            retry_delay(attempt, retry_after).await;
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    }
                } else {
                    None
                };
                return Ok(TransportReply { response, xml });
            }
            if status.is_success()
                && matches!(
                    expected,
                    ExpectedBody::CreateXml | ExpectedBody::CompleteXml
                )
            {
                // The SDK also retries transient failures while reading XML
                // responses. Complete may carry an Error inside HTTP 200.
                let body = match bounded_bytes(&mut response, MAX_XML_BYTES).await {
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
                if matches!(expected, ExpectedBody::CompleteXml) {
                    let document = parse_xml(&body)?;
                    if document.root_element().tag_name().name() != "CompleteMultipartUploadResult"
                    {
                        let code = xml_code(&body);
                        if attempt < MAX_ATTEMPTS
                            && is_retryable(status, code.as_deref(), measured_skew)
                            && self.reserve_retry(&mut retry_permit, retry_cost(code.as_deref()))
                        {
                            retry_delay(attempt, retry_after).await;
                            continue;
                        }
                        return Err(R2Error::S3(format!(
                            "complete_multipart_upload: unexpected response {}",
                            code.as_deref().unwrap_or("unknown")
                        )));
                    }
                }
                self.reward_success(&mut retry_permit);
                return Ok(TransportReply {
                    response,
                    xml: Some(body),
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
                            && self.reserve_retry(&mut retry_permit, 5) =>
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
                                if retryable_transport(&e) { 10 } else { 5 },
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
                    && self.reserve_retry(&mut retry_permit, retry_cost(code.as_deref()))
                {
                    retry_delay(attempt, retry_after).await;
                    continue;
                }
                return Err(R2Error::S3(format!(
                    "R2 request: HTTP {status}, code {}",
                    code.as_deref().unwrap_or("unknown")
                )));
            }
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
        match response.status() {
            StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            _ => Err(status_error("head_object", response).await),
        }
    }

    pub(super) async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error> {
        let TransportReply { response, xml } = self
            .execute(
                Method::GET,
                key,
                &[],
                Bytes::new(),
                None,
                ExpectedBody::GetMissingXml,
            )
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            // Unlike HEAD, a 404 may be a missing bucket. Require NoSuchKey.
            if xml.as_deref().and_then(xml_code).as_deref() == Some("NoSuchKey") {
                return Ok(None);
            }
            return Err(R2Error::S3(
                "get_object returned 404 without NoSuchKey".into(),
            ));
        }
        if !response.status().is_success() {
            return Err(status_error("get_object", response).await);
        }
        let content_length = response
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<i64>().ok());
        let stream = response.bytes_stream().map_err(io::Error::other);
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
        let document = parse_xml(&body)?;
        if document.root_element().tag_name().name() != "InitiateMultipartUploadResult" {
            return Err(R2Error::S3(
                "unexpected CreateMultipartUpload response".into(),
            ));
        }
        document
            .root_element()
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == "UploadId")
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
                &[("partNumber", &pn), ("uploadId", upload_id)],
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
            xml.push_str("<Part><PartNumber>");
            xml.push_str(&part.number.to_string());
            xml.push_str("</PartNumber><ETag>");
            xml.push_str(&xml_escape(&part.etag));
            xml.push_str("</ETag></Part>");
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
                &[("uploadId", upload_id)],
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
    let server: SystemTime = chrono::DateTime::parse_from_rfc2822(date)
        .ok()?
        .with_timezone(&chrono::Utc)
        .into();
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

fn retry_cost(code: Option<&str>) -> u32 {
    if matches!(
        code,
        Some("InternalError" | "RequestTimeout" | "RequestTimeoutException")
    ) {
        10
    } else {
        5
    }
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
            Some(
                "InternalError"
                    | "RequestTimeout"
                    | "RequestTimeoutException"
                    | "SlowDown"
                    | "Throttling"
                    | "ThrottlingException"
                    | "ThrottledException"
                    | "RequestThrottledException"
                    | "TooManyRequestsException"
                    | "RequestLimitExceeded"
                    | "BandwidthLimitExceeded"
                    | "RequestThrottled"
                    | "PriorRequestNotComplete"
                    | "ProvisionedThroughputExceededException"
                    | "TransactionInProgressException"
                    | "EC2ThrottledException"
            )
        )
}

async fn retry_delay(attempt: usize, retry_after: Option<Duration>) {
    if let Some(retry_after) = retry_after {
        tokio::time::sleep(retry_after).await;
        return;
    }
    // Standard SDK backoff is exponential with full jitter, starting at 1s.
    // This is a non-cryptographic delay; no randomness is used for signing.
    let cap_ms = 1_000u64 << (attempt - 1);
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    tokio::time::sleep(Duration::from_millis(nanos % (cap_ms + 1))).await;
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

fn xml_code(body: &[u8]) -> Option<String> {
    let doc = parse_xml(body).ok()?;
    if doc.root_element().tag_name().name() != "Error" {
        return None;
    }
    let code = doc
        .root_element()
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "Code")?;
    code.text().map(str::to_owned)
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
