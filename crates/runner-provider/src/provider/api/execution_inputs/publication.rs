//! One publication stream; the existing context and bundle types own their schemas.

use super::{ContentBundles, SkillBundle, StartupInputs};
use runner_types::types::ExecutionContext;
use serde::de::value::{CowStrDeserializer, MapAccessDeserializer};
use serde::de::{DeserializeSeed, Error as _, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::{borrow::Cow, fmt};

pub(super) struct ExecutionPublication {
    pub(super) context: ExecutionContext,
    pub(super) packages: Packages,
}

pub(super) enum Packages {
    Explicit(StartupInputs),
    Legacy(ContentBundles<SkillBundle>),
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
        let mut storage = None;
        let mut explicit = None;
        let mut context =
            ExecutionContext::deserialize(MapAccessDeserializer::new(ContextFields {
                map,
                packages: &mut packages,
                storage: &mut storage,
                explicit: &mut explicit,
            }))?;
        // Only decode the selected form. Member order does not affect precedence.
        let packages = if let Some(inputs) = explicit {
            Packages::Explicit(serde_json::from_str(inputs.get()).map_err(M::Error::custom)?)
        } else {
            // #51111 removes this branch once older APIs have drained and left the rollback set.
            if let Some(storage) = storage {
                context.storage_manifest =
                    serde_json::from_str(storage.get()).map_err(M::Error::custom)?;
            }
            let bundles = packages.ok_or_else(|| M::Error::missing_field("contentBundles"))?;
            Packages::Legacy(serde_json::from_str(bundles.get()).map_err(M::Error::custom)?)
        };
        Ok(ExecutionPublication { context, packages })
    }
}

struct ContextFields<'a, 'de, M> {
    map: M,
    packages: &'a mut Option<&'de RawValue>,
    storage: &'a mut Option<&'de RawValue>,
    explicit: &'a mut Option<&'de RawValue>,
}

// Ordinary JSON keys borrow the input; escaped keys retain their decoded value.
#[derive(Deserialize)]
struct FieldName<'a>(#[serde(borrow)] Cow<'a, str>);

impl<'de, M: MapAccess<'de>> MapAccess<'de> for ContextFields<'_, 'de, M> {
    type Error = M::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, Self::Error> {
        while let Some(FieldName(key)) = self.map.next_key()? {
            let (name, field) = match key.as_ref() {
                "contentBundles" => ("contentBundles", &mut self.packages),
                "storageManifest" => ("storageManifest", &mut self.storage),
                "startupInputs" => ("startupInputs", &mut self.explicit),
                _ => return seed.deserialize(CowStrDeserializer::new(key)).map(Some),
            };
            if field.is_some() {
                return Err(M::Error::duplicate_field(name));
            }
            **field = Some(self.map.next_value()?);
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
