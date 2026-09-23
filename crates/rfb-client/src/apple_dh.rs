//! Apple DH / ARD security type 30. This legacy method authenticates a client
//! but does not authenticate the server or protect the post-authentication RFB
//! session. Product admission must supply a separate verified outer channel.

use aes::{
    Aes128,
    cipher::{Block, BlockCipherEncrypt, KeyInit},
};
use crypto_bigint::{
    BoxedUint, Odd,
    modular::{BoxedMontyForm, BoxedMontyParams},
};
use md5::{Digest, Md5};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::Instant,
};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    AppleDhCredentials, Authenticated, AuthenticatedStream, AuthenticationStage, Error,
    authentication::{discard_reason, phase, read_security_result},
};

const APPLE_VERSION: &[u8; 12] = b"RFB 003.889\n";
const CLIENT_VERSION: &[u8; 12] = b"RFB 003.008\n";
const APPLE_DH: u8 = 30;
// A 2048-bit minimum and 4096-bit maximum bound both weak groups and peer CPU
// work. The independently exercised macOS 26.6.2 server uses 512 bytes.
const MIN_KEY_BYTES: usize = 256;
const MAX_KEY_BYTES: usize = 512;
const PRIVATE_BYTES: usize = 32;
const FIELD_BYTES: usize = 64;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    credentials: AppleDhCredentials,
    deadline: Instant,
) -> Result<Authenticated<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    phase(
        AuthenticationStage::RfbVersion,
        deadline,
        exchange_version(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        select_apple_dh(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::AppleDhAuthentication,
        deadline,
        exchange_credentials(&mut stream, credentials, deadline),
    )
    .await?;
    Ok(Authenticated {
        stream: AuthenticatedStream::apple_dh_raw(stream),
    })
}

async fn exchange_version<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let mut version = [0; 12];
    stream.read_exact(&mut version).await?;
    if &version != APPLE_VERSION {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(CLIENT_VERSION).await?;
    stream.flush().await?;
    Ok(())
}

async fn select_apple_dh<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(stream).await?;
        return Err(Error::ServerRejected);
    }
    let mut types = [0u8; u8::MAX as usize];
    let offered = types
        .get_mut(..usize::from(count))
        .ok_or(Error::InvalidAppleDhParameters)?;
    stream.read_exact(offered).await?;
    if !offered.contains(&APPLE_DH) {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u8(APPLE_DH).await?;
    stream.flush().await?;
    Ok(())
}

async fn exchange_credentials<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    credentials: AppleDhCredentials,
    deadline: Instant,
) -> Result<(), Error> {
    let generator = stream.read_u16().await?;
    let key_bytes = usize::from(stream.read_u16().await?);
    if !(2..=255).contains(&generator)
        || !(MIN_KEY_BYTES..=MAX_KEY_BYTES).contains(&key_bytes)
        || key_bytes % 16 != 0
    {
        return Err(Error::InvalidAppleDhParameters);
    }

    let mut modulus_bytes = [0u8; MAX_KEY_BYTES];
    let mut server_public_bytes = [0u8; MAX_KEY_BYTES];
    let modulus_slice = modulus_bytes
        .get_mut(..key_bytes)
        .ok_or(Error::InvalidAppleDhParameters)?;
    stream.read_exact(modulus_slice).await?;
    let server_public_slice = server_public_bytes
        .get_mut(..key_bytes)
        .ok_or(Error::InvalidAppleDhParameters)?;
    stream.read_exact(server_public_slice).await?;
    if modulus_slice.first().is_none_or(|byte| byte & 0x80 == 0)
        || modulus_slice.last().is_none_or(|byte| byte & 1 == 0)
    {
        return Err(Error::InvalidAppleDhParameters);
    }

    let bits = u32::try_from(key_bytes * 8).map_err(|_| Error::InvalidAppleDhParameters)?;
    let modulus = BoxedUint::from_be_slice(modulus_slice, bits)
        .map_err(|_| Error::InvalidAppleDhParameters)?;
    let one = BoxedUint::from_be_slice(&[1], bits).map_err(|_| Error::InvalidAppleDhParameters)?;
    let two = BoxedUint::from_be_slice(&[2], bits).map_err(|_| Error::InvalidAppleDhParameters)?;
    let modulus_minus_one = modulus.wrapping_sub(&one);
    let server_public = BoxedUint::from_be_slice(server_public_slice, bits)
        .map_err(|_| Error::InvalidAppleDhParameters)?;
    if server_public < two || server_public >= modulus_minus_one {
        return Err(Error::InvalidAppleDhParameters);
    }
    let generator = BoxedUint::from_be_slice(&generator.to_be_bytes(), bits)
        .map_err(|_| Error::InvalidAppleDhParameters)?;
    if generator >= modulus_minus_one {
        return Err(Error::InvalidAppleDhParameters);
    }
    let odd =
        Option::<Odd<BoxedUint>>::from(Odd::new(modulus)).ok_or(Error::InvalidAppleDhParameters)?;
    let params = BoxedMontyParams::new_vartime(odd);

    let mut private_bytes = Zeroizing::new([0u8; PRIVATE_BYTES]);
    getrandom::fill(&mut *private_bytes).map_err(|_| Error::Randomness)?;
    // Keep a full 256-bit, nonzero ephemeral exponent. The peer cannot select
    // exponent length or arithmetic work.
    *private_bytes.first_mut().ok_or(Error::Randomness)? |= 0x80;
    *private_bytes.last_mut().ok_or(Error::Randomness)? |= 1;
    let private = Zeroizing::new(
        BoxedUint::from_be_slice(&*private_bytes, bits)
            .map_err(|_| Error::InvalidAppleDhParameters)?,
    );
    drop(private_bytes);

    let client_public = Zeroizing::new(
        BoxedMontyForm::new(generator, &params)
            .pow_bounded_exp(&private, (PRIVATE_BYTES * 8) as u32)
            .retrieve(),
    );
    tokio::task::yield_now().await;
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleDhAuthentication,
        });
    }
    let shared = Zeroizing::new(
        BoxedMontyForm::new(server_public, &params)
            .pow_bounded_exp(&private, (PRIVATE_BYTES * 8) as u32)
            .retrieve(),
    );
    drop(private);
    let shared_bytes = Zeroizing::new(shared.to_be_bytes());
    drop(shared);
    let client_public_bytes = Zeroizing::new(client_public.to_be_bytes());
    drop(client_public);

    let mut digest = Md5::digest(&*shared_bytes);
    drop(shared_bytes);
    let mut key = Zeroizing::new([0u8; 16]);
    key.copy_from_slice(&digest);
    digest.as_mut_slice().zeroize();
    // The aes crate's `zeroize` feature clears its key schedule on Drop.
    let cipher = Aes128::new((&*key).into());
    drop(key);

    let mut encrypted = Zeroizing::new([0u8; FIELD_BYTES * 2]);
    getrandom::fill(&mut *encrypted).map_err(|_| Error::Randomness)?;
    let (username_field, password_field) = encrypted.split_at_mut(FIELD_BYTES);
    username_field
        .get_mut(..credentials.username.len())
        .ok_or(Error::InvalidAppleDhUsername)?
        .copy_from_slice(&credentials.username);
    *username_field
        .get_mut(credentials.username.len())
        .ok_or(Error::InvalidAppleDhUsername)? = 0;
    password_field
        .get_mut(..credentials.password.len())
        .ok_or(Error::InvalidAppleDhPassword)?
        .copy_from_slice(&credentials.password);
    *password_field
        .get_mut(credentials.password.len())
        .ok_or(Error::InvalidAppleDhPassword)? = 0;
    drop(credentials);
    for chunk in encrypted.as_chunks_mut::<16>().0 {
        let mut block = Block::<Aes128>::default();
        block.copy_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
        block.as_mut_slice().zeroize();
    }
    drop(cipher);
    if deadline <= Instant::now() {
        return Err(Error::AuthenticationDeadlineExceeded {
            stage: AuthenticationStage::AppleDhAuthentication,
        });
    }
    stream.write_all(&*encrypted).await?;
    stream.write_all(&client_public_bytes).await?;
    stream.flush().await?;
    drop(encrypted);
    drop(client_public_bytes);
    read_security_result(stream).await
}
