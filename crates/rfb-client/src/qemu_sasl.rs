//! QEMU 8.2.2's explicitly nonstandard X509SASL/SCRAM-SHA-256 exchange.
//!
//! Its X509SASL wire ID is 263, whereas the published RFB extension assigns
//! X509SASL 264. The caller negotiates exactly 263 and **always** verifies the
//! server certificate before entering this module. QEMU's 264/TLSSASL is never
//! substituted. SCRAM has no session security layer: verified TLS stays active.

use base64::Engine;
use rsasl::{
    callback::{Request, SessionCallback},
    config::SASLConfig,
    mechanisms::scram::SCRAM_SHA256,
    prelude::{Registry, SASLClient, Session, SessionError, State},
    property::{AuthId, Password},
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

use crate::{Error, QemuScramCredentials, authentication::read_security_result};

const MECHANISM: &[u8] = b"SCRAM-SHA-256";
const MAX_OFFER: u32 = 4096;
const MAX_STEP: u32 = 16 * 1024;
const MAX_TOTAL: usize = 128 * 1024;
const MAX_ITERATIONS: u32 = 100_000;

struct Credentials(QemuScramCredentials);

impl SessionCallback for Credentials {
    fn callback(
        &self,
        _session: &rsasl::callback::SessionData,
        _context: &rsasl::callback::Context,
        request: &mut Request<'_>,
    ) -> Result<(), SessionError> {
        request
            .satisfy::<AuthId>(self.0.username.as_str())?
            .satisfy::<Password>(self.0.password.as_bytes())?;
        Ok(())
    }
}

/// Called only after rustls has verified both the server's chain and name.
pub(crate) async fn authenticate<S>(
    stream: &mut S,
    credentials: QemuScramCredentials,
) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let offer_len = stream.read_u32().await?;
    if !(1..=MAX_OFFER).contains(&offer_len) {
        return Err(Error::InvalidScramExchange);
    }
    let mut offer = Zeroizing::new(vec![0u8; offer_len as usize]);
    stream.read_exact(&mut offer).await?;
    if !offer.split(|byte| *byte == b',').all(|name| {
        !name.is_empty()
            && name.len() <= 100
            && name
                .iter()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'-' || *b == b'_')
    }) {
        return Err(Error::InvalidScramExchange);
    }
    if !offer
        .split(|byte| *byte == b',')
        .any(|name| name == MECHANISM)
    {
        return Err(Error::UnsupportedScramMechanism);
    }
    drop(offer);

    static ONLY_SCRAM: &[rsasl::prelude::Mechanism] = &[SCRAM_SHA256];
    let config = SASLConfig::builder()
        .with_registry(Registry::with_mechanisms(ONLY_SCRAM))
        .with_callback(Credentials(credentials))
        .map_err(|_| Error::InvalidScramExchange)?;
    let mut session = SASLClient::new(config)
        .start_suggested_iter([SCRAM_SHA256.mechanism])
        .map_err(|_| Error::UnsupportedScramMechanism)?;
    if !session.are_we_first() {
        return Err(Error::InvalidScramExchange);
    }
    let (next, state, first) = step(session, None).await?;
    session = next;
    if !matches!(state, State::Running) || first.is_empty() {
        return Err(Error::InvalidScramExchange);
    }
    stream.write_u32(MECHANISM.len() as u32).await?;
    stream.write_all(MECHANISM).await?;
    write_blob(stream, Some(&first)).await?;
    drop(first);

    // SCRAM has exactly two server messages. Do not wait for arbitrary extra
    // rounds, or mistake QEMU's complete flag for mutual authentication.
    let mut total = MECHANISM.len();
    for round in 0..2 {
        let (server_data, complete) = read_blob(stream, &mut total).await?;
        if complete != (round == 1) {
            return Err(Error::InvalidScramExchange);
        }
        if round == 0 {
            let first = server_data.as_ref().ok_or(Error::InvalidScramExchange)?;
            validate_server_first(first)?; // bound PBKDF2 before rsasl sees i=
        }
        let (next, state, client_data) = step(session, server_data).await?;
        session = next;
        if round == 0 {
            if !matches!(state, State::Running) || client_data.is_empty() {
                return Err(Error::InvalidScramExchange);
            }
            write_blob(stream, Some(&client_data)).await?;
        } else if !matches!(state, State::Finished(_))
            || state.has_sent_message()
            || !client_data.is_empty()
            || session.has_security_layer()
        {
            return Err(Error::InvalidScramExchange);
        }
        drop(client_data);
    }
    drop(session); // drop callback credentials before waiting for SecurityResult
    read_security_result(stream).await
}

async fn step(
    mut session: Session,
    input: Option<Zeroizing<Vec<u8>>>,
) -> Result<(Session, State, Zeroizing<Vec<u8>>), Error> {
    // rsasl's PBKDF2 is synchronous; a Tokio timeout cannot interrupt it.
    // The server-first iteration/salt bounds above make this CPU task finite,
    // while spawn_blocking keeps cancellation/deadlines responsive for I/O.
    tokio::task::spawn_blocking(move || {
        let mut output = Zeroizing::new(Vec::new());
        let state = session
            .step(input.as_ref().map(|bytes| bytes.as_slice()), &mut *output)
            .map_err(|_| Error::InvalidScramExchange)?;
        if output.len() > MAX_STEP as usize {
            return Err(Error::InvalidScramExchange);
        }
        Ok((session, state, output))
    })
    .await
    .map_err(|_| Error::InvalidScramExchange)?
}

async fn write_blob<S: AsyncWrite + Unpin>(
    stream: &mut S,
    data: Option<&[u8]>,
) -> Result<(), Error> {
    match data {
        None => stream.write_u32(0).await?,
        Some(bytes) if bytes.len() <= MAX_STEP as usize => {
            // NUL padding distinguishes a non-NULL zero-length SASL output
            // from a NULL pointer (wire length zero). The NUL is not SASL data.
            stream.write_u32((bytes.len() + 1) as u32).await?;
            stream.write_all(bytes).await?;
            stream.write_u8(0).await?;
        }
        Some(_) => return Err(Error::InvalidScramExchange),
    }
    stream.flush().await?;
    Ok(())
}

async fn read_blob<S: AsyncRead + Unpin>(
    stream: &mut S,
    total: &mut usize,
) -> Result<(Option<Zeroizing<Vec<u8>>>, bool), Error> {
    let size = stream.read_u32().await?;
    if size > MAX_STEP {
        return Err(Error::InvalidScramExchange);
    }
    *total = total
        .checked_add(size as usize)
        .filter(|count| *count <= MAX_TOTAL)
        .ok_or(Error::InvalidScramExchange)?;
    let data = if size == 0 {
        None
    } else {
        let mut data = Zeroizing::new(vec![0u8; size as usize]);
        stream.read_exact(&mut data).await?;
        if data.pop() != Some(0) {
            return Err(Error::InvalidScramExchange);
        }
        Some(data)
    };
    let complete = match stream.read_u8().await? {
        0 => false,
        1 => true,
        _ => return Err(Error::InvalidScramExchange),
    };
    Ok((data, complete))
}

fn validate_server_first(data: &[u8]) -> Result<(), Error> {
    if data.len() > MAX_STEP as usize {
        return Err(Error::InvalidScramExchange);
    }
    let parts: Vec<&[u8]> = data.split(|b| *b == b',').collect();
    let [nonce, salt, iterations] = parts.as_slice() else {
        return Err(Error::InvalidScramExchange);
    };
    let (Some(nonce), Some(salt), Some(iterations)) = (
        nonce.strip_prefix(b"r="),
        salt.strip_prefix(b"s="),
        iterations.strip_prefix(b"i="),
    ) else {
        return Err(Error::InvalidScramExchange);
    };
    if !(8..=256).contains(&nonce.len())
        || !nonce.iter().all(u8::is_ascii_graphic)
        || salt.len() > 172
        || !salt
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/' || *b == b'=')
        || !iterations.iter().all(u8::is_ascii_digit)
        || iterations.len() > 6
    {
        return Err(Error::InvalidScramExchange);
    }
    let salt = base64::engine::general_purpose::STANDARD
        .decode(salt)
        .map_err(|_| Error::InvalidScramExchange)?;
    if !(8..=128).contains(&salt.len()) {
        return Err(Error::InvalidScramExchange);
    }
    let count = std::str::from_utf8(iterations)
        .map_err(|_| Error::InvalidScramExchange)?
        .parse::<u32>()
        .map_err(|_| Error::InvalidScramExchange)?;
    if !(4096..=MAX_ITERATIONS).contains(&count) {
        return Err(Error::InvalidScramExchange);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_cpu_budget_is_checked_before_rsasl() {
        let good = b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=4096";
        assert!(validate_server_first(good).is_ok());
        for bad in [
            &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=1000000"[..],
            &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=0"[..],
            &b"r=abcdefgh12345678,s=%,i=4096"[..],
            &b"r=abcdefgh12345678,s=c2FsdHNhbHRzYWx0,i=4096,m=extra"[..],
        ] {
            assert!(matches!(
                validate_server_first(bad),
                Err(Error::InvalidScramExchange)
            ));
        }
    }

    #[tokio::test]
    async fn wire_distinguishes_null_empty_and_bad_padding() {
        let (mut client, mut server) = tokio::io::duplex(100);
        server
            .write_all(&[0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1])
            .await
            .unwrap();
        let mut count = 0;
        assert!(
            read_blob(&mut client, &mut count)
                .await
                .unwrap()
                .0
                .is_none()
        );
        assert_eq!(
            read_blob(&mut client, &mut count)
                .await
                .unwrap()
                .0
                .unwrap()
                .len(),
            0
        );
        assert!(matches!(
            read_blob(&mut client, &mut count).await,
            Err(Error::InvalidScramExchange)
        ));
    }
}
