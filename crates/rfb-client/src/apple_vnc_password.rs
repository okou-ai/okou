//! Apple Remote Management's optional classic VNC password / RFB security
//! type 2. The password authenticates the client, not the server; neither the
//! challenge nor SecurityResult encrypts the subsequent RFB desktop stream.

use tokio::{
    io::{AsyncRead, AsyncWrite},
    time::Instant,
};

use crate::{
    Authenticated, AuthenticatedStream, AuthenticationStage, Error, VncPassword,
    authentication::{authenticate_apple_vnc, phase, select_security_type},
    version::{ServerVersion, exchange_version},
};

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
        exchange_version(&mut stream, ServerVersion::Apple),
    )
    .await?;
    phase(
        AuthenticationStage::SecurityNegotiation,
        deadline,
        select_security_type(&mut stream, VNC_AUTH),
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
