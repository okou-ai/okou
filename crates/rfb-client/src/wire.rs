use tokio::io::{AsyncRead, AsyncReadExt};

use crate::{
    Error,
    memory::{Budget, Buffer},
};

pub(crate) struct Wire {
    remaining: usize,
}

impl Wire {
    pub(crate) fn new() -> Self {
        Self {
            remaining: 64 * 1024 * 1024,
        }
    }

    fn charge(&mut self, bytes: usize) -> Result<(), Error> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or(Error::ResourceLimit)?;
        Ok(())
    }

    pub(crate) async fn bytes<S: AsyncRead + Unpin>(
        &mut self,
        stream: &mut S,
        data: &mut [u8],
    ) -> Result<(), Error> {
        self.charge(data.len())?;
        stream.read_exact(data).await?;
        Ok(())
    }

    pub(crate) async fn byte<S: AsyncRead + Unpin>(&mut self, stream: &mut S) -> Result<u8, Error> {
        self.charge(1)?;
        Ok(stream.read_u8().await?)
    }

    pub(crate) async fn short<S: AsyncRead + Unpin>(
        &mut self,
        stream: &mut S,
    ) -> Result<u16, Error> {
        self.charge(2)?;
        Ok(stream.read_u16().await?)
    }

    pub(crate) async fn long<S: AsyncRead + Unpin>(
        &mut self,
        stream: &mut S,
    ) -> Result<u32, Error> {
        self.charge(4)?;
        Ok(stream.read_u32().await?)
    }

    pub(crate) async fn buffer<S: AsyncRead + Unpin>(
        &mut self,
        stream: &mut S,
        len: usize,
        budget: &Budget,
    ) -> Result<Buffer, Error> {
        self.charge(len)?;
        let mut buffer = budget.buffer(len)?;
        stream.read_exact(&mut buffer).await?;
        Ok(buffer)
    }
}

pub(crate) fn validate_format(format: [u8; 16]) -> Result<(), Error> {
    let [
        bpp,
        depth,
        _,
        true_color,
        r0,
        r1,
        g0,
        g1,
        b0,
        b1,
        rs,
        gs,
        bs,
        _,
        _,
        _,
    ] = format;
    if ![8, 16, 32].contains(&bpp) || depth == 0 || depth > bpp {
        return Err(Error::InvalidPixelFormat);
    }
    if true_color == 0 {
        return Ok(());
    }
    let mut used = 0u32;
    let mut bits = 0;
    for (max, shift) in [
        (u16::from_be_bytes([r0, r1]), rs),
        (u16::from_be_bytes([g0, g1]), gs),
        (u16::from_be_bytes([b0, b1]), bs),
    ] {
        let max = u32::from(max);
        // An unused channel has max = 2^0 - 1 and may start at the bpp boundary.
        if (max + 1).count_ones() != 1 || u32::from(shift) + max.count_ones() > u32::from(bpp) {
            return Err(Error::InvalidPixelFormat);
        }
        let mask = u64::from(max) << shift;
        if mask >= (1u64 << bpp) || mask & u64::from(used) != 0 {
            return Err(Error::InvalidPixelFormat);
        }
        used |= mask as u32;
        bits += max.count_ones();
    }
    if bits > u32::from(depth) {
        return Err(Error::InvalidPixelFormat);
    }
    Ok(())
}
