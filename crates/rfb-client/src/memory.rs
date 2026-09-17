use std::{
    ops::{Deref, DerefMut},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use crate::Error;

pub(crate) const MAX_MEMORY: usize = 128 * 1024 * 1024;

#[derive(Clone, Default)]
pub(crate) struct Budget(Arc<Accounting>);

#[derive(Default)]
struct Accounting {
    used: AtomicUsize,
    peak: AtomicUsize,
}

impl Budget {
    pub(crate) fn reserve(&self, bytes: usize) -> Result<Reservation, Error> {
        let previous = self
            .0
            .used
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |used| {
                used.checked_add(bytes).filter(|&sum| sum <= MAX_MEMORY)
            })
            .map_err(|_| Error::ResourceLimit)?;
        self.0.peak.fetch_max(previous + bytes, Ordering::Relaxed);
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }

    pub(crate) fn buffer(&self, len: usize) -> Result<Buffer, Error> {
        let mut reservation = self.reserve(len)?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(len)
            .map_err(|_| Error::ResourceLimit)?;
        // Account actual capacity, including any allocator over-allocation.
        if bytes.capacity() > len {
            let extra = self.reserve(bytes.capacity() - len)?;
            reservation.bytes += extra.bytes;
            // Transfer this reservation without subtracting the transferred bytes.
            let mut extra = extra;
            extra.bytes = 0;
        }
        bytes.resize(len, 0);
        Ok(Buffer {
            bytes,
            _reservation: reservation,
        })
    }

    pub(crate) fn usage(&self) -> (usize, usize) {
        (
            self.0.used.load(Ordering::Relaxed),
            self.0.peak.load(Ordering::Relaxed),
        )
    }
}

pub(crate) struct Reservation {
    budget: Budget,
    bytes: usize,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.0.used.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}

pub(crate) struct Buffer {
    bytes: Vec<u8>,
    _reservation: Reservation,
}

impl Deref for Buffer {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}

impl DerefMut for Buffer {
    fn deref_mut(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}
