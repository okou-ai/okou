//! Local log observations shared by the two full-size stdout contracts.

use std::borrow::Cow;

#[derive(serde::Deserialize)]
pub struct LocalItem<'a> {
    pub id: String,
    // The log already owns this 65 MiB scalar. Borrow unescaped JSON strings;
    // Cow still decodes escaped text rather than changing the content oracle.
    #[serde(borrow)]
    pub aggregated_output: Cow<'a, str>,
    // A flattened remainder makes Serde require an object, rather than also
    // accepting a positional array as this struct's observed fields.
    #[serde(flatten)]
    _remaining: serde::de::IgnoredAny,
}
