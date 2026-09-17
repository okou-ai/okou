//! Tile decoding after the connection's persistent zlib inflater has run.

use crate::Error;

const TILE_SIZE: usize = 64;
const PIXEL_BYTES: usize = 4;

/// Decode one bounded, decompressed ZRLE rectangle into canonical RGBA pixels.
/// The caller validates positive dimensions and the exact output buffer size.
/// `tile` is caller-owned scratch for at least 64 * 64 RGBA pixels.
pub(crate) async fn decode(
    mut data: &[u8],
    width: usize,
    height: usize,
    output: &mut [u8],
    tile: &mut [u8],
) -> Result<(), Error> {
    for y in (0..height).step_by(TILE_SIZE) {
        let tile_height = TILE_SIZE.min(height - y);
        for x in (0..width).step_by(TILE_SIZE) {
            let tile_width = TILE_SIZE.min(width - x);
            let tile = tile
                .get_mut(..tile_width * tile_height * PIXEL_BYTES)
                .ok_or(Error::InvalidCompressedData)?;
            decode_tile(&mut data, tile_width, tile)?;
            let start = x * PIXEL_BYTES;
            let end = start + tile_width * PIXEL_BYTES;
            for (source, destination) in tile.chunks_exact(tile_width * PIXEL_BYTES).zip(
                output
                    .chunks_exact_mut(width * PIXEL_BYTES)
                    .skip(y)
                    .take(tile_height),
            ) {
                destination
                    .get_mut(start..end)
                    .ok_or(Error::InvalidCompressedData)?
                    .copy_from_slice(source);
            }
            // Each tile is at most 4096 pixels, bounding work between yields.
            tokio::task::yield_now().await;
        }
    }
    if !data.is_empty() {
        return Err(Error::InvalidCompressedData);
    }
    Ok(())
}

fn decode_tile(data: &mut &[u8], width: usize, output: &mut [u8]) -> Result<(), Error> {
    match read_byte(data)? {
        0 => {
            for destination in output.as_chunks_mut::<PIXEL_BYTES>().0 {
                destination.copy_from_slice(&read_pixel(data)?);
            }
            Ok(())
        }
        1 => {
            fill(output, read_pixel(data)?);
            Ok(())
        }
        size @ 2..=16 => {
            let palette = read_palette(data, usize::from(size))?;
            decode_packed(
                data,
                width,
                output,
                palette
                    .get(..usize::from(size))
                    .ok_or(Error::InvalidCompressedData)?,
            )
        }
        128 => decode_runs(data, output, None),
        encoding @ 130..=255 => {
            let size = usize::from(encoding - 128);
            let palette = read_palette(data, size)?;
            decode_runs(
                data,
                output,
                Some(palette.get(..size).ok_or(Error::InvalidCompressedData)?),
            )
        }
        _ => Err(Error::InvalidCompressedData),
    }
}

fn decode_packed(
    data: &mut &[u8],
    width: usize,
    output: &mut [u8],
    palette: &[[u8; PIXEL_BYTES]],
) -> Result<(), Error> {
    let bits = match palette.len() {
        2 => 1,
        3..=4 => 2,
        5..=16 => 4,
        _ => return Err(Error::InvalidCompressedData),
    };
    let pixels_per_byte = 8 / bits;
    let mask = (1 << bits) - 1;
    // A new packed byte starts every row, even when the preceding row ended
    // partway through one. Unused low bits are padding, not palette indices.
    for row in output.chunks_exact_mut(width * PIXEL_BYTES) {
        for group in row.chunks_mut(pixels_per_byte * PIXEL_BYTES) {
            let packed = read_byte(data)?;
            for (position, destination) in group
                .as_chunks_mut::<PIXEL_BYTES>()
                .0
                .iter_mut()
                .enumerate()
            {
                let shift = 8 - bits * (position + 1);
                let index = usize::from((packed >> shift) & mask);
                destination
                    .copy_from_slice(palette.get(index).ok_or(Error::InvalidCompressedData)?);
            }
        }
    }
    Ok(())
}

fn decode_runs(
    data: &mut &[u8],
    mut output: &mut [u8],
    palette: Option<&[[u8; PIXEL_BYTES]]>,
) -> Result<(), Error> {
    while !output.is_empty() {
        let (pixel, encoded_length) = match palette {
            Some(palette) => {
                let index = read_byte(data)?;
                let pixel = *palette
                    .get(usize::from(index & 0x7f))
                    .ok_or(Error::InvalidCompressedData)?;
                (pixel, index & 0x80 != 0)
            }
            None => (read_pixel(data)?, true),
        };
        let length = if encoded_length {
            read_run_length(data, output.len() / PIXEL_BYTES)?
        } else {
            1
        };
        let (run, remaining) = output
            .split_at_mut_checked(length * PIXEL_BYTES)
            .ok_or(Error::InvalidCompressedData)?;
        fill(run, pixel);
        output = remaining;
    }
    Ok(())
}

fn read_run_length(data: &mut &[u8], remaining: usize) -> Result<usize, Error> {
    let mut length = 1;
    loop {
        let byte = read_byte(data)?;
        length += usize::from(byte);
        // Checking each byte also bounds accumulation and continuation work.
        if length > remaining {
            return Err(Error::InvalidCompressedData);
        }
        if byte != 255 {
            return Ok(length);
        }
    }
}

fn read_palette(data: &mut &[u8], size: usize) -> Result<[[u8; PIXEL_BYTES]; 127], Error> {
    let mut palette = [[0; PIXEL_BYTES]; 127];
    for color in palette
        .get_mut(..size)
        .ok_or(Error::InvalidCompressedData)?
    {
        *color = read_pixel(data)?;
    }
    Ok(palette)
}

fn read_pixel(data: &mut &[u8]) -> Result<[u8; PIXEL_BYTES], Error> {
    Ok([read_byte(data)?, read_byte(data)?, read_byte(data)?, 255])
}

fn read_byte(data: &mut &[u8]) -> Result<u8, Error> {
    let (byte, remaining) = data.split_first().ok_or(Error::InvalidCompressedData)?;
    *data = remaining;
    Ok(*byte)
}

fn fill(output: &mut [u8], color: [u8; PIXEL_BYTES]) {
    for destination in output.as_chunks_mut::<PIXEL_BYTES>().0 {
        destination.copy_from_slice(&color);
    }
}
