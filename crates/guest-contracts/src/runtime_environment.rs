//! Build-owned runtime defaults shared by rootfs installation and guest processes.
//!
//! This is trusted data, not a bootstrap or user-environment policy. Consumers
//! own installation, inherited-value selection, overrides, and PATH suffixes.

/// Common system PATH prefix, before consumer-specific games or user directories.
pub const SYSTEM_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Trusted rootfs defaults for fixed Agent launch and nonempty CLI inheritance.
///
/// Values are literal, unquoted `/etc/environment` data: keep them free of
/// whitespace, quotes, and shell expansion. Bootstrap controls, credentials,
/// identities, and user-specific paths do not belong in this catalog.
pub const TRUSTED_ROOTFS_ENVIRONMENT: &[(&str, &str)] = &[
    ("LANG", "C.UTF-8"),
    ("RUSTUP_HOME", "/usr/local/rustup"),
    ("NPM_CONFIG_UPDATE_NOTIFIER", "false"),
    (
        "NODE_EXTRA_CA_CERTS",
        "/usr/local/share/ca-certificates/vm0-proxy-ca.crt",
    ),
    ("AGENT_BROWSER_USE_SYSTEM_CA", "1"),
    ("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"),
    ("REQUESTS_CA_BUNDLE", "/etc/ssl/certs/ca-certificates.crt"),
    ("CARGO_HTTP_CAINFO", "/etc/ssl/certs/ca-certificates.crt"),
];
