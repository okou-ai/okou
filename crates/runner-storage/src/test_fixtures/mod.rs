//! Storage fixtures shared with dependent crates through opt-in test support.

mod http_body;
mod multipart;
pub use http_body::byte_stream_with_error_after;
pub use multipart::multipart_success_rules;

#[cfg(test)]
pub(crate) use raw_http_test_support::raw_http;
#[cfg(test)]
pub(crate) use runner_host::test_fixtures::ignored_child;
