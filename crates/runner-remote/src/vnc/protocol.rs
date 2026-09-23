use super::Failure;
use rfb_client::{Input, Key, MouseButton, ScrollAxis, SharingMode};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Mode {
    Shared,
    Exclusive,
}

impl From<Mode> for SharingMode {
    fn from(mode: Mode) -> Self {
        match mode {
            Mode::Shared => Self::Shared,
            Mode::Exclusive => Self::Exclusive,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Start {
    pub(super) connection_id: Uuid,
    pub(super) mode: Mode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct SessionId {
    pub(super) session_id: Uuid,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Empty {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Info {
    pub(super) session_id: Uuid,
    pub(super) connection_id: Uuid,
    pub(super) mode: Mode,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct InputRequest {
    pub(super) session_id: Uuid,
    pub(super) input: Command,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Geometry {
    pub(super) session_id: Uuid,
    pub(super) epoch: u64,
}

impl From<Geometry> for rfb_client::Geometry {
    fn from(value: Geometry) -> Self {
        Self {
            session_id: value.session_id,
            epoch: value.epoch,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Button {
    Left,
    Middle,
    Right,
}
impl From<Button> for MouseButton {
    fn from(value: Button) -> Self {
        match value {
            Button::Left => Self::Left,
            Button::Middle => Self::Middle,
            Button::Right => Self::Right,
        }
    }
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Axis {
    Vertical,
    Horizontal,
}
impl From<Axis> for ScrollAxis {
    fn from(value: Axis) -> Self {
        match value {
            Axis::Vertical => Self::Vertical,
            Axis::Horizontal => Self::Horizontal,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Command {
    Text {
        text: String,
    },
    KeyChord {
        keys: Vec<String>,
    },
    Click {
        geometry: Geometry,
        x: u16,
        y: u16,
        button: Button,
    },
    Drag {
        geometry: Geometry,
        points: Vec<(u16, u16)>,
        button: Button,
    },
    Scroll {
        geometry: Geometry,
        x: u16,
        y: u16,
        axis: Axis,
        steps: i16,
    },
}

impl Command {
    pub(super) fn keys(&self) -> Result<Vec<Key>, Failure> {
        if let Self::KeyChord { keys } = self {
            if !(1..=8).contains(&keys.len()) {
                return Err(Failure::InvalidInput);
            }
            keys.iter().map(|key| parse_key(key)).collect()
        } else {
            Ok(Vec::new())
        }
    }
    pub(super) fn as_input<'a>(&'a self, keys: &'a [Key]) -> Input<'a> {
        match self {
            Self::Text { text } => Input::Text(text),
            Self::KeyChord { .. } => Input::KeyChord(keys),
            Self::Click {
                geometry,
                x,
                y,
                button,
            } => Input::Click {
                geometry: (*geometry).into(),
                x: *x,
                y: *y,
                button: (*button).into(),
            },
            Self::Drag {
                geometry,
                points,
                button,
            } => Input::Drag {
                geometry: (*geometry).into(),
                points,
                button: (*button).into(),
            },
            Self::Scroll {
                geometry,
                x,
                y,
                axis,
                steps,
            } => Input::Scroll {
                geometry: (*geometry).into(),
                x: *x,
                y: *y,
                axis: (*axis).into(),
                steps: *steps,
            },
        }
    }
}

fn parse_key(value: &str) -> Result<Key, Failure> {
    Ok(match value {
        "Enter" => Key::Enter,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Backspace" => Key::Backspace,
        "Delete" => Key::Delete,
        "Insert" => Key::Insert,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "Left" => Key::Left,
        "Right" => Key::Right,
        "Up" => Key::Up,
        "Down" => Key::Down,
        "Shift" => Key::Shift,
        "Control" => Key::Control,
        "Alt" => Key::Alt,
        "Meta" => Key::Meta,
        _ => {
            let mut chars = value.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if !c.is_control() => Key::Character(c),
                _ => match value.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
                    Some(n) if (1..=35).contains(&n) && value == format!("F{n}") => {
                        Key::Function(n)
                    }
                    _ => return Err(Failure::InvalidInput),
                },
            }
        }
    })
}
