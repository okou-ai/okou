// RFB version exchange adapted from vnc-rs at
// ab684d009d767c968af2f7559576334038623124 (MIT; see ../LICENSE-vnc-rs).

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::Error;

const RFB_VERSION: &[u8; 12] = b"RFB 003.008\n";
const APPLE_VERSION: &[u8; 12] = b"RFB 003.889\n";

pub(crate) enum ServerVersion {
    Rfb38,
    Apple,
}

pub(crate) async fn exchange_version<S>(stream: &mut S, server: ServerVersion) -> Result<(), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let expected = match server {
        ServerVersion::Rfb38 => RFB_VERSION,
        ServerVersion::Apple => APPLE_VERSION,
    };
    let mut version = [0; 12];
    stream.read_exact(&mut version).await?;
    if &version != expected {
        return Err(Error::UnsupportedRfbVersion);
    }
    stream.write_all(RFB_VERSION).await?;
    stream.flush().await?;
    Ok(())
}
