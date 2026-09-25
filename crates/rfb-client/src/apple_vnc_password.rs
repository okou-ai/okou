//! Apple Remote Management's optional classic VNC password / RFB security
//! type 2. The password authenticates the client, not the server; neither the
//! challenge nor SecurityResult encrypts the subsequent RFB desktop stream.

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    time::Instant,
};

use crate::{
    Authenticated, AuthenticatedStream, AuthenticationStage, Error, VncPassword,
    authentication::{authenticate_apple_vnc, discard_reason, phase},
};

const APPLE_VERSION: &[u8; 12] = b"RFB 003.889\n";
const CLIENT_VERSION: &[u8; 12] = b"RFB 003.008\n";
const VNC_AUTH: u8 = 2;

pub(crate) async fn authenticate<S>(
    mut stream: S,
    password: VncPassword,
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
        select_vnc_auth(&mut stream),
    )
    .await?;
    phase(
        AuthenticationStage::VncAuthentication,
        deadline,
        authenticate_apple_vnc(&mut stream, password),
    )
    .await?;
    Ok(Authenticated {
        stream: AuthenticatedStream::apple_vnc_password_raw(stream),
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

async fn select_vnc_auth<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(), Error> {
    let count = stream.read_u8().await?;
    if count == 0 {
        discard_reason(stream).await?;
        return Err(Error::ServerRejected);
    }
    let mut types = [0u8; u8::MAX as usize];
    let offered = types
        .get_mut(..usize::from(count))
        .ok_or(Error::UnsupportedSecurity)?;
    stream.read_exact(offered).await?;
    if !offered.contains(&VNC_AUTH) {
        return Err(Error::UnsupportedSecurity);
    }
    stream.write_u8(VNC_AUTH).await?;
    stream.flush().await?;
    Ok(())
}
