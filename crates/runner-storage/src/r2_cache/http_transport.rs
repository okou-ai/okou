//! Narrow, signed R2/S3 HTTP transport for the six template-cache operations.
//!
//! The production cache uses this transport. Operation-level doubles and
//! signed-wire tests cover cache orchestration and protocol behavior.

use std::{
    io,
    pin::Pin,
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
use tokio::io::AsyncRead;
use tokio_util::io::StreamReader;
use url::Url;

use super::R2Error;

const MAX_XML_BYTES: usize = 64 * 1024;
const MAX_ERROR_BYTES: usize = 16 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(60);
const PART_TIMEOUT: Duration = Duration::from_secs(300);

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
            .time(SystemTime::now())
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

    async fn execute(
        &self,
        method: Method,
        key: &str,
        query: &[(&str, &str)],
        body: Bytes,
        content_type: Option<&str>,
    ) -> Result<Response, R2Error> {
        let url = self.url(key, query)?;
        let is_part = method == Method::PUT;
        let request = self.signed_request(method, url, body, content_type)?;
        let client = if is_part {
            &self.part_client
        } else {
            &self.client
        };
        client.execute(request).await.map_err(|e| {
            if e.is_timeout() {
                R2Error::S3(format!("R2 request timeout: {e}"))
            } else {
                R2Error::S3(format!("R2 request failed: {e}"))
            }
        })
    }

    pub(super) async fn head(&self, key: &str) -> Result<bool, R2Error> {
        let response = self
            .execute(Method::HEAD, key, &[], Bytes::new(), None)
            .await?;
        match response.status() {
            StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            _ => Err(status_error("head_object", response).await),
        }
    }

    pub(super) async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error> {
        let response = self
            .execute(Method::GET, key, &[], Bytes::new(), None)
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            // Unlike HEAD, a 404 may be a missing bucket. Require NoSuchKey.
            let body = bounded_bytes(response, MAX_ERROR_BYTES).await?;
            if xml_code(&body).as_deref() == Some("NoSuchKey") {
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
        let response = self
            .execute(Method::POST, key, &[("uploads", "")], Bytes::new(), None)
            .await?;
        if !response.status().is_success() {
            return Err(status_error("create_multipart_upload", response).await);
        }
        let body = bounded_bytes(response, MAX_XML_BYTES).await?;
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
            )
            .await?;
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
            )
            .await?;
        if !response.status().is_success() {
            return Err(status_error("complete_multipart_upload", response).await);
        }
        // S3 and R2 can report a failed Complete with HTTP 200 and an XML Error.
        let body = bounded_bytes(response, MAX_XML_BYTES).await?;
        let document = parse_xml(&body)?;
        if document.root_element().tag_name().name() != "CompleteMultipartUploadResult" {
            return Err(R2Error::S3(format!(
                "complete_multipart_upload: unexpected response {}",
                xml_code(&body).as_deref().unwrap_or("unknown")
            )));
        }
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
            )
            .await?;
        if !response.status().is_success() {
            return Err(status_error("abort_multipart_upload", response).await);
        }
        Ok(())
    }
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

async fn bounded_bytes(response: Response, max: usize) -> Result<Bytes, R2Error> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| R2Error::S3(format!("read R2 response: {e}")))?;
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|len| len > max)
        {
            return Err(R2Error::S3("R2 XML response exceeds size limit".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(bytes))
}

async fn status_error(operation: &str, response: Response) -> R2Error {
    let status = response.status();
    let body = bounded_bytes(response, MAX_ERROR_BYTES).await;
    let code = body.as_ref().ok().and_then(|body| xml_code(body));
    R2Error::S3(format!(
        "{operation}: HTTP {status}, code {}",
        code.as_deref().unwrap_or("unknown")
    ))
}

#[cfg(test)]
#[path = "http_transport_tests.rs"]
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
