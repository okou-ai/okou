use crate::{
    Error, Geometry,
    memory::{Budget, Buffer},
};

const MAX_EVENTS: usize = 4096;
const EVENT_BYTES: usize = 8;

/// Result of application-input delivery, independent of application acceptance.
/// A cancelled operation retains the last value in its caller-owned outcome.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum InputOutcome {
    /// No application-input write has been attempted.
    #[default]
    NotStarted,
    /// A write was attempted; any part of the operation may have taken effect.
    Unknown,
    /// All intended presses/releases were written and flushed before the deadline.
    Sent,
}

/// A standard RFB pointer button.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    fn mask(self) -> u8 {
        match self {
            Self::Left => 1,
            Self::Middle => 2,
            Self::Right => 4,
        }
    }
}

/// Positive scroll steps move down or right; negative steps move up or left.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScrollAxis {
    Vertical,
    Horizontal,
}

/// A logical X11 key, not a physical keyboard scan code. Character insertion
/// depends on the server's keyboard implementation and the target application.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Key {
    Character(char),
    Enter,
    Tab,
    Escape,
    Backspace,
    Delete,
    Insert,
    Home,
    End,
    PageUp,
    PageDown,
    Left,
    Right,
    Up,
    Down,
    Shift,
    Control,
    Alt,
    Meta,
    /// X11 function keys F1 through F35.
    Function(u8),
}

/// One bounded, balanced input operation. No operation leaves buttons or keys
/// intentionally held. Coordinates are exact framebuffer pixels.
pub enum Input<'a> {
    Click {
        geometry: Geometry,
        x: u16,
        y: u16,
        button: MouseButton,
    },
    /// Press at the first point, visit each subsequent point, release at the
    /// last point. Requires 2-256 points; there are no hidden timed interpolations.
    Drag {
        geometry: Geometry,
        points: &'a [(u16, u16)],
        button: MouseButton,
    },
    /// Send 1-100 wheel press/release pairs at the supplied coordinate.
    Scroll {
        geometry: Geometry,
        x: u16,
        y: u16,
        axis: ScrollAxis,
        steps: i16,
    },
    /// At most 4 KiB UTF-8 and 4,096 emitted press/release events. Newline and
    /// tab map to their named keys; other control characters are rejected.
    Text(&'a str),
    /// Press 1-8 distinct keys in the given order, then release in reverse.
    KeyChord(&'a [Key]),
}

pub(crate) struct Sequence {
    pub(crate) geometry: Option<Geometry>,
    bytes: Buffer,
    len: usize,
    coordinate_max: Option<(u16, u16)>,
}

impl Sequence {
    pub(crate) fn validate_geometry(
        &self,
        current: Geometry,
        width: u16,
        height: u16,
    ) -> Result<(), Error> {
        if self.geometry.is_some_and(|geometry| geometry != current) {
            return Err(Error::StaleGeometry);
        }
        if self
            .coordinate_max
            .is_some_and(|(x, y)| x >= width || y >= height)
        {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }

    pub(crate) fn messages(&self) -> impl Iterator<Item = &[u8]> {
        self.bytes
            .as_chunks::<EVENT_BYTES>()
            .0
            .iter()
            .take(self.len)
            .map(|slot| {
                let [tag, ..] = slot;
                if *tag == 4 {
                    slot.as_slice()
                } else {
                    // Pointer events occupy six bytes in the fixed eight-byte slot.
                    slot.split_at(6).0
                }
            })
    }

    fn push(&mut self, message: [u8; EVENT_BYTES]) -> Result<(), Error> {
        if self.len >= MAX_EVENTS {
            return Err(Error::InvalidInput);
        }
        self.bytes
            .as_chunks_mut::<EVENT_BYTES>()
            .0
            .get_mut(self.len)
            .ok_or(Error::InvalidInput)?
            .copy_from_slice(&message);
        self.len += 1;
        Ok(())
    }

    fn key(&mut self, keysym: u32, down: bool) -> Result<(), Error> {
        let [a, b, c, d] = keysym.to_be_bytes();
        self.push([4, u8::from(down), 0, 0, a, b, c, d])
    }

    fn pointer(&mut self, x: u16, y: u16, mask: u8) -> Result<(), Error> {
        self.coordinate_max = Some(match self.coordinate_max {
            Some((old_x, old_y)) => (old_x.max(x), old_y.max(y)),
            None => (x, y),
        });
        let [x0, x1] = x.to_be_bytes();
        let [y0, y1] = y.to_be_bytes();
        self.push([5, mask, x0, x1, y0, y1, 0, 0])
    }
}

/// Compile every event before the caller takes ownership of the transport.
/// A validation failure therefore cannot cause a partially submitted operation.
pub(crate) fn compile(input: Input<'_>, budget: &Budget) -> Result<Sequence, Error> {
    let mut sequence = Sequence {
        geometry: None,
        bytes: budget.buffer(MAX_EVENTS * EVENT_BYTES)?,
        len: 0,
        coordinate_max: None,
    };
    match input {
        Input::Click {
            geometry,
            x,
            y,
            button,
        } => {
            sequence.geometry = Some(geometry);
            sequence.pointer(x, y, button.mask())?;
            sequence.pointer(x, y, 0)?;
        }
        Input::Drag {
            geometry,
            points,
            button,
        } => {
            if !(2..=256).contains(&points.len()) {
                return Err(Error::InvalidInput);
            }
            sequence.geometry = Some(geometry);
            for &(x, y) in points {
                sequence.pointer(x, y, button.mask())?;
            }
            let &(x, y) = points.last().ok_or(Error::InvalidInput)?;
            sequence.pointer(x, y, 0)?;
        }
        Input::Scroll {
            geometry,
            x,
            y,
            axis,
            steps,
        } => {
            let count = steps.unsigned_abs();
            if !(1..=100).contains(&count) {
                return Err(Error::InvalidInput);
            }
            sequence.geometry = Some(geometry);
            let mask = match (axis, steps > 0) {
                (ScrollAxis::Vertical, false) => 8,
                (ScrollAxis::Vertical, true) => 16,
                (ScrollAxis::Horizontal, false) => 32,
                (ScrollAxis::Horizontal, true) => 64,
            };
            for _ in 0..count {
                sequence.pointer(x, y, mask)?;
                sequence.pointer(x, y, 0)?;
            }
        }
        Input::Text(text) => {
            if text.is_empty() || text.len() > 4096 {
                return Err(Error::InvalidInput);
            }
            for character in text.chars() {
                let key = match character {
                    '\n' => Key::Enter,
                    '\t' => Key::Tab,
                    character => Key::Character(character),
                };
                let keysym = keysym(key)?;
                sequence.key(keysym, true)?;
                sequence.key(keysym, false)?;
            }
        }
        Input::KeyChord(keys) => {
            if !(1..=8).contains(&keys.len()) {
                return Err(Error::InvalidInput);
            }
            let mut seen = [0; 8];
            for (index, &key) in keys.iter().enumerate() {
                let keysym = keysym(key)?;
                if seen.contains(&keysym) {
                    return Err(Error::InvalidInput);
                }
                *seen.get_mut(index).ok_or(Error::InvalidInput)? = keysym;
                sequence.key(keysym, true)?;
            }
            for &key in keys.iter().rev() {
                sequence.key(keysym(key)?, false)?;
            }
        }
    }
    Ok(sequence)
}

fn keysym(key: Key) -> Result<u32, Error> {
    Ok(match key {
        Key::Character(character) => {
            if character.is_control() {
                return Err(Error::InvalidInput);
            }
            let scalar = u32::from(character);
            if scalar <= 0xff {
                scalar
            } else {
                0x0100_0000 | scalar
            }
        }
        Key::Enter => 0xff0d,
        Key::Tab => 0xff09,
        Key::Escape => 0xff1b,
        Key::Backspace => 0xff08,
        Key::Delete => 0xffff,
        Key::Insert => 0xff63,
        Key::Home => 0xff50,
        Key::End => 0xff57,
        Key::PageUp => 0xff55,
        Key::PageDown => 0xff56,
        Key::Left => 0xff51,
        Key::Right => 0xff53,
        Key::Up => 0xff52,
        Key::Down => 0xff54,
        Key::Shift => 0xffe1,
        Key::Control => 0xffe3,
        Key::Alt => 0xffe9,
        Key::Meta => 0xffe7,
        Key::Function(number) if (1..=35).contains(&number) => 0xffbd + u32::from(number),
        Key::Function(_) => return Err(Error::InvalidInput),
    })
}
