//! One publication stream; the existing context and bundle types own their schemas.

use super::ContentBundles;
use runner_types::types::ExecutionContext;
use serde::de::value::{CowStrDeserializer, MapAccessDeserializer};
use serde::de::{DeserializeSeed, Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::{borrow::Cow, fmt};

pub(super) struct ExecutionPublication {
    pub(super) context: ExecutionContext,
    pub(super) packages: ContentBundles,
}

impl<'de> Deserialize<'de> for ExecutionPublication {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(PublicationVisitor)
    }
}

struct PublicationVisitor;

impl<'de> Visitor<'de> for PublicationVisitor {
    type Value = ExecutionPublication;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an execution publication")
    }

    fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
        let mut packages = None;
        let context = ExecutionContext::deserialize(MapAccessDeserializer::new(ContextFields {
            map,
            packages: &mut packages,
        }))?;
        Ok(ExecutionPublication {
            context,
            packages: packages.ok_or_else(|| M::Error::missing_field("contentBundles"))?,
        })
    }
}

struct ContextFields<'a, M> {
    map: M,
    packages: &'a mut Option<ContentBundles>,
}

// Ordinary JSON keys borrow the input; escaped keys retain their decoded value.
#[derive(Deserialize)]
struct FieldName<'a>(#[serde(borrow)] Cow<'a, str>);

impl<'de, M: MapAccess<'de>> MapAccess<'de> for ContextFields<'_, M> {
    type Error = M::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        while let Some(FieldName(key)) = self.map.next_key()? {
            if key == "contentBundles" {
                if self.packages.is_some() {
                    return Err(M::Error::duplicate_field("contentBundles"));
                }
                *self.packages = Some(self.map.next_value()?);
            } else {
                return seed.deserialize(CowStrDeserializer::new(key)).map(Some);
            }
        }
        Ok(None)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(
        &mut self,
        seed: V,
    ) -> Result<V::Value, Self::Error> {
        self.map.next_value_seed(seed)
    }
}
