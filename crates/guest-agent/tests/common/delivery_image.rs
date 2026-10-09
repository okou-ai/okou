//! Valid RGB PNGs with uncompressed pixel data exercise Base64 transport size.
use base64::Engine as _;
use std::io::Write;

pub fn png_base64(width: u32, height: u32) -> std::io::Result<String> {
    fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        png.extend_from_slice(&(data.len() as u32).to_be_bytes());
        png.extend_from_slice(kind);
        png.extend_from_slice(data);
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        png.extend_from_slice(&crc.sum().to_be_bytes());
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::new();
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(&mut png, b"IHDR", &header);
    let mut pixels = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::none());
    // RGB values repeat every 256 columns and rows. Build each distinct row
    // once, while retaining every pixel and the same per-row zlib writes.
    let mut scanlines = Vec::with_capacity(height.min(256) as usize);
    for row in 0..height.min(256) {
        let mut period = Vec::with_capacity(width.min(256) as usize * 3);
        for column in 0..width.min(256) {
            period.extend_from_slice(&[row as u8, column as u8, 128]);
        }
        let mut scanline = Vec::with_capacity(1 + width as usize * 3);
        scanline.push(0);
        for _ in 0..width / 256 {
            scanline.extend_from_slice(&period);
        }
        scanline.extend(period.iter().take((width % 256) as usize * 3).copied());
        scanlines.push(scanline);
    }
    for scanline in scanlines.iter().cycle().take(height as usize) {
        pixels.write_all(scanline)?;
    }
    chunk(&mut png, b"IDAT", &pixels.finish()?);
    chunk(&mut png, b"IEND", &[]);
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}
