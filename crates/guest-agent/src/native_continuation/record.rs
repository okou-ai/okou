//! Admission facts only: never retain arbitrary history JSON subtrees.

use serde::Deserialize;
use serde::de::{DeserializeSeed, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

#[derive(Default)]
pub(super) struct Record {
    pub kind: Option<String>,
    pub session_id: Option<String>,
    pub id: Option<String>,
    pub version: Option<u64>,
    pub message: Message,
    pub payload: Payload,
    pub summary: bool,
}

#[derive(Default)]
pub(super) struct Message {
    pub role: Option<String>,
    pub content: bool,
}

#[derive(Default)]
pub(super) struct Payload {
    pub kind: Option<String>,
    pub id: Option<String>,
    pub role: Option<String>,
    pub content: bool,
    pub arguments: bool,
    pub output: bool,
    pub message: bool,
    pub replacement_history: bool,
}

pub(super) fn parse(line: &str) -> Result<Record, serde_json::Error> {
    let mut record = Record::default();
    let mut deserializer = serde_json::Deserializer::from_str(line);
    Field::Record(&mut record).deserialize(&mut deserializer)?;
    deserializer.end()?;
    Ok(record)
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "camelCase")]
enum Key {
    #[serde(rename = "type")]
    Kind,
    SessionId,
    Id,
    Version,
    Message,
    Payload,
    Summary,
    Role,
    Content,
    Arguments,
    Output,
    #[serde(rename = "replacement_history")]
    ReplacementHistory,
    #[serde(other)]
    Other,
}

enum Field<'a> {
    Record(&'a mut Record),
    Message(&'a mut Message),
    Payload(&'a mut Payload),
    Text(&'a mut Option<String>),
    Version(&'a mut Option<u64>),
    Content(&'a mut bool),
    Ignore,
}

impl Field<'_> {
    fn child(&mut self, key: Key) -> Field<'_> {
        match self {
            Self::Record(record) => match key {
                Key::Kind => Field::Text(&mut record.kind),
                Key::SessionId => Field::Text(&mut record.session_id),
                Key::Id => Field::Text(&mut record.id),
                Key::Version => Field::Version(&mut record.version),
                Key::Message => Field::Message(&mut record.message),
                Key::Payload => Field::Payload(&mut record.payload),
                Key::Summary => Field::Content(&mut record.summary),
                _ => Field::Ignore,
            },
            Self::Message(message) => match key {
                Key::Role => Field::Text(&mut message.role),
                Key::Content => Field::Content(&mut message.content),
                _ => Field::Ignore,
            },
            Self::Payload(payload) => match key {
                Key::Kind => Field::Text(&mut payload.kind),
                Key::Id => Field::Text(&mut payload.id),
                Key::Role => Field::Text(&mut payload.role),
                Key::Content => Field::Content(&mut payload.content),
                Key::Arguments => Field::Content(&mut payload.arguments),
                Key::Output => Field::Content(&mut payload.output),
                Key::Message => Field::Content(&mut payload.message),
                Key::ReplacementHistory => Field::Content(&mut payload.replacement_history),
                _ => Field::Ignore,
            },
            _ => Field::Ignore,
        }
    }
}

impl<'de> DeserializeSeed<'de> for Field<'_> {
    type Value = ();

    fn deserialize<D>(self, deserializer: D) -> Result<(), D::Error>
    where
        D: Deserializer<'de>,
    {
        // Value's object insertion was last-key-wins, including replacement
        // with a wrong-shaped value. Reset the whole selected field each time.
        let mut field = self;
        match &mut field {
            Self::Record(value) => **value = Record::default(),
            Self::Message(value) => **value = Message::default(),
            Self::Payload(value) => **value = Payload::default(),
            Self::Text(value) => **value = None,
            Self::Version(value) => **value = None,
            Self::Content(value) => **value = false,
            Self::Ignore => {}
        }
        deserializer.deserialize_any(field)
    }
}

impl<'de> Visitor<'de> for Field<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<(), E> {
        Ok(())
    }

    fn visit_bool<E>(self, _value: bool) -> Result<(), E> {
        Ok(())
    }

    fn visit_i64<E>(self, value: i64) -> Result<(), E> {
        if let Self::Version(version) = self {
            *version = u64::try_from(value).ok();
        }
        Ok(())
    }

    fn visit_u64<E>(self, value: u64) -> Result<(), E> {
        if let Self::Version(version) = self {
            *version = Some(value);
        }
        Ok(())
    }

    fn visit_f64<E>(self, _value: f64) -> Result<(), E> {
        Ok(())
    }

    fn visit_str<E>(self, value: &str) -> Result<(), E> {
        match self {
            Self::Text(text) => *text = Some(value.to_owned()),
            Self::Content(nonempty) => *nonempty = !value.trim().is_empty(),
            _ => {}
        }
        Ok(())
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<(), A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut nonempty = false;
        while sequence.next_element_seed(Field::Ignore)?.is_some() {
            nonempty = true;
        }
        if let Self::Content(content) = self {
            *content = nonempty;
        }
        Ok(())
    }

    fn visit_map<A>(mut self, mut map: A) -> Result<(), A::Error>
    where
        A: MapAccess<'de>,
    {
        while let Some(key) = map.next_key::<Key>()? {
            // Even ignored values traverse deserialize_any rather than
            // IgnoredAny's fast skip: retain Value's number and depth checks.
            map.next_value_seed(self.child(key))?;
        }
        Ok(())
    }
}
