//! Rust bindings for selected `@okouai/api-contracts` routes, DTOs, response
//! decode paths, and shared constants.
//!
//! Route constants under [`generated::routes`] are generated from the
//! TypeScript supported-route registry. Request/response DTOs under
//! [`generated::types`] are generated from the selected Rust DTO registry.
//! Response schemas under [`generated::decode_paths`] provide contract-owned,
//! location-aware field metadata for sanitized JSON decode diagnostics.
//! Narrow cross-language contract constants are generated under
//! [`generated::constants`]. Regenerate all bindings with:
//!
//! ```bash
//! cd turbo && pnpm -F @okouai/api-contracts generate:rust
//! ```
//!
//! Static routes are generated as [`Route`] constants. Routes with path
//! parameters are generated as [`RouteTemplate`] constants plus typed `Params`
//! and `route(...)` helpers that return [`ResolvedRoute`]. Use [`Route::url`]
//! for static routes and [`ResolvedRoute::url`] after applying path params.
//!
//! Add new Rust-supported routes to
//! `turbo/packages/api-contracts/src/rust-bindings/routes.ts`, and add new
//! Rust-supported DTOs to
//! `turbo/packages/api-contracts/src/rust-bindings/types.ts`. Register response
//! decode-path schemas in
//! `turbo/packages/api-contracts/src/rust-bindings/decode-paths.ts`. Add shared
//! constants only when they are part of an explicit Rust/TypeScript contract,
//! and register them under `turbo/packages/api-contracts/src/rust-bindings/`.

// Variant names mirror wire discriminants; changing their shared suffix would
// break the generated contract's explicit names without improving hand-written code.
#[allow(clippy::enum_variant_names)]
pub mod generated;

mod decode_path;
mod route;
mod secret_text;

pub use decode_path::{DecodePathCursor, DecodePathMapSegment, DecodePathSchema};
pub use route::{Method, ResolvedRoute, Route, RouteTemplate};
pub use secret_text::{SecretText, SecretUtf8Text};
