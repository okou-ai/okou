use crate::{
    Error,
    memory::{Budget, Buffer},
};

pub(crate) const MAX_DIMENSION: u16 = 8192;
pub(crate) const MAX_PIXELS: usize = 8_388_608;

pub(crate) fn pixel_count(width: u16, height: u16) -> Result<usize, Error> {
    let pixels = usize::from(width) * usize::from(height);
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || pixels > MAX_PIXELS
    {
        return Err(Error::InvalidFramebuffer);
    }
    Ok(pixels)
}

#[derive(Clone, Copy)]
pub(crate) struct Rect {
    pub(crate) x: u16,
    pub(crate) y: u16,
    pub(crate) width: u16,
    pub(crate) height: u16,
}

pub(crate) struct Frame {
    pub(crate) width: u16,
    pub(crate) height: u16,
    pub(crate) epoch: u64,
    pixels: Buffer,
    known: Buffer,
    missing: usize,
}

impl Frame {
    pub(crate) fn new(width: u16, height: u16, epoch: u64, budget: &Budget) -> Result<Self, Error> {
        let count = pixel_count(width, height)?;
        Ok(Self {
            width,
            height,
            epoch,
            pixels: budget.buffer(count * 4)?,
            known: budget.buffer(count.div_ceil(8))?,
            missing: count,
        })
    }

    pub(crate) fn pixels(&self) -> Option<&[u8]> {
        (self.missing == 0).then_some(&self.pixels)
    }

    pub(crate) fn invalidate(&mut self) {
        self.known.fill(0);
        self.missing = usize::from(self.width) * usize::from(self.height);
    }

    pub(crate) fn validate(&self, rect: Rect) -> Result<(), Error> {
        if rect.width == 0
            || rect.height == 0
            || u32::from(rect.x) + u32::from(rect.width) > u32::from(self.width)
            || u32::from(rect.y) + u32::from(rect.height) > u32::from(self.height)
        {
            return Err(Error::InvalidFramebuffer);
        }
        Ok(())
    }

    fn valid(&self, index: usize) -> Result<bool, Error> {
        Ok(self.known.get(index / 8).ok_or(Error::InvalidFramebuffer)? & (1 << (index % 8)) != 0)
    }

    fn mark(&mut self, index: usize, valid: bool) -> Result<(), Error> {
        let byte = self
            .known
            .get_mut(index / 8)
            .ok_or(Error::InvalidFramebuffer)?;
        let mask = 1 << (index % 8);
        let old = *byte & mask != 0;
        if old != valid {
            if valid {
                *byte |= mask;
                self.missing -= 1;
            } else {
                *byte &= !mask;
                self.missing += 1;
            }
        }
        Ok(())
    }

    pub(crate) async fn paint(&mut self, rect: Rect, rgba: &[u8]) -> Result<(), Error> {
        self.validate(rect)?;
        let row_len = usize::from(rect.width) * 4;
        for row in 0..usize::from(rect.height) {
            let index = (usize::from(rect.y) + row) * usize::from(self.width) + usize::from(rect.x);
            self.pixels
                .get_mut(index * 4..index * 4 + row_len)
                .ok_or(Error::InvalidFramebuffer)?
                .copy_from_slice(
                    rgba.get(row * row_len..(row + 1) * row_len)
                        .ok_or(Error::InvalidFramebuffer)?,
                );
            for pixel in index..index + usize::from(rect.width) {
                self.mark(pixel, true)?;
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }

    pub(crate) async fn copy(
        &mut self,
        rect: Rect,
        source_x: u16,
        source_y: u16,
    ) -> Result<(), Error> {
        self.validate(rect)?;
        self.validate(Rect {
            x: source_x,
            y: source_y,
            ..rect
        })?;
        for row in 0..usize::from(rect.height) {
            let row = if rect.y > source_y {
                usize::from(rect.height) - 1 - row
            } else {
                row
            };
            for col in 0..usize::from(rect.width) {
                let col = if rect.x > source_x {
                    usize::from(rect.width) - 1 - col
                } else {
                    col
                };
                let source = (usize::from(source_y) + row) * usize::from(self.width)
                    + usize::from(source_x)
                    + col;
                let target = (usize::from(rect.y) + row) * usize::from(self.width)
                    + usize::from(rect.x)
                    + col;
                let mut pixel = [0; 4];
                pixel.copy_from_slice(
                    self.pixels
                        .get(source * 4..source * 4 + 4)
                        .ok_or(Error::InvalidFramebuffer)?,
                );
                let valid = self.valid(source)?;
                self.pixels
                    .get_mut(target * 4..target * 4 + 4)
                    .ok_or(Error::InvalidFramebuffer)?
                    .copy_from_slice(&pixel);
                self.mark(target, valid)?;
            }
            tokio::task::yield_now().await;
        }
        Ok(())
    }
}
