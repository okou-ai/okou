//! Operations exercised by the template-cache, not a general S3 client.
use super::{
    R2Error,
    http_transport::{DownloadResponse, Part, R2HttpClient},
};
use bytes::Bytes;

#[async_trait::async_trait]
pub(super) trait R2Transport: Send + Sync {
    async fn head(&self, key: &str) -> Result<bool, R2Error>;
    async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error>;
    async fn create_multipart(&self, key: &str) -> Result<String, R2Error>;
    async fn upload_part(
        &self,
        key: &str,
        upload_id: &str,
        number: i32,
        chunk: Bytes,
    ) -> Result<Part, R2Error>;
    async fn complete_multipart(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[Part],
    ) -> Result<(), R2Error>;
    async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<(), R2Error>;
}

#[async_trait::async_trait]
impl R2Transport for R2HttpClient {
    async fn head(&self, key: &str) -> Result<bool, R2Error> {
        self.head(key).await
    }
    async fn get(&self, key: &str) -> Result<Option<DownloadResponse>, R2Error> {
        self.get(key).await
    }
    async fn create_multipart(&self, key: &str) -> Result<String, R2Error> {
        self.create_multipart(key).await
    }
    async fn upload_part(
        &self,
        key: &str,
        id: &str,
        number: i32,
        chunk: Bytes,
    ) -> Result<Part, R2Error> {
        self.upload_part(key, id, number, chunk).await
    }
    async fn complete_multipart(&self, key: &str, id: &str, parts: &[Part]) -> Result<(), R2Error> {
        self.complete_multipart(key, id, parts).await
    }
    async fn abort_multipart(&self, key: &str, id: &str) -> Result<(), R2Error> {
        self.abort_multipart(key, id).await
    }
}
