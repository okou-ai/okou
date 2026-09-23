use std::sync::{
    Arc,
    atomic::{AtomicU8, Ordering},
};

/// Lifecycle-owned gate for whether completed jobs may enter the idle pool.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParkingState {
    Open = 0,
    SoftDraining = 1,
    Closed = 2,
}

impl ParkingState {
    fn from_u8(value: u8) -> Self {
        match value {
            0 => Self::Open,
            1 => Self::SoftDraining,
            2 => Self::Closed,
            _ => Self::Closed,
        }
    }
}

/// Shared parking permission updated before publishing runner mode transitions.
#[derive(Clone, Debug)]
pub struct ParkingGate {
    state: Arc<AtomicU8>,
}

impl ParkingGate {
    pub fn new_open() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(ParkingState::Open as u8)),
        }
    }

    pub fn state(&self) -> ParkingState {
        ParkingState::from_u8(self.state.load(Ordering::SeqCst))
    }

    pub fn is_open(&self) -> bool {
        self.state() == ParkingState::Open
    }

    pub fn soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::Open as u8,
            ParkingState::SoftDraining as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::SoftDraining,
        }
    }

    pub fn open_after_soft_drain(&self) -> bool {
        match self.state.compare_exchange(
            ParkingState::SoftDraining as u8,
            ParkingState::Open as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => true,
            Err(state) => ParkingState::from_u8(state) == ParkingState::Open,
        }
    }

    pub fn close(&self) {
        self.state
            .store(ParkingState::Closed as u8, Ordering::SeqCst);
    }
}

impl Default for ParkingGate {
    fn default() -> Self {
        Self::new_open()
    }
}
