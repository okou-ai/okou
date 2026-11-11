use zeroize::Zeroizing;

use crate::Error;

type CredentialBytes = Zeroizing<Vec<u8>>;

/// Transfer the existing allocation without making another plaintext copy.
pub(super) fn into_bytes(mut value: Zeroizing<String>) -> CredentialBytes {
    Zeroizing::new(std::mem::take(&mut *value).into_bytes())
}

pub(super) fn valid_nul_free_field(value: &[u8], max_bytes: usize) -> bool {
    (1..=max_bytes).contains(&value.len()) && !value.contains(&0)
}

/// Share ownership and rejection ordering while keeping protocol policy explicit.
pub(super) fn utf8_pair(
    username: String,
    password: Zeroizing<String>,
    (username_max, username_error): (usize, Error),
    (password_max, password_error): (usize, Error),
) -> Result<(CredentialBytes, CredentialBytes), Error> {
    // Both allocations are protected before either field can be rejected.
    let username = Zeroizing::new(username.into_bytes());
    let password = into_bytes(password);
    if !valid_nul_free_field(&username, username_max) {
        return Err(username_error);
    }
    if !valid_nul_free_field(&password, password_max) {
        return Err(password_error);
    }
    Ok((username, password))
}
