//! Claude Code tool tracking.

use crate::events;
use std::collections::HashMap;
use tokio::time::Instant;

/// Maximum number of network tool calls retained by the stuck-tool watchdog.
///
/// This is intentionally higher than the normal parallelism of Claude Code,
/// while keeping the control-process allocation bounded if a child emits
/// unmatched tool-use events indefinitely.
pub(super) const MAX_TRACKED_STUCK_TOOLS: usize = 256;

/// Maximum number of bytes in one tool-use ID retained by the watchdog.
pub(super) const MAX_TRACKED_STUCK_TOOL_ID_BYTES: usize = 1024;

/// Network tools whose unmatched calls are handled by the stuck-tool watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StuckToolName {
    /// Claude's web search tool.
    WebSearch,

    /// Claude's web fetch tool.
    WebFetch,
}

impl StuckToolName {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "WebSearch" => Some(Self::WebSearch),
            "WebFetch" => Some(Self::WebFetch),
            _ => None,
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::WebSearch => "WebSearch",
            Self::WebFetch => "WebFetch",
        }
    }
}

/// Bounded in-flight state used by the stuck-tool watchdog.
pub(super) struct StuckToolTracker {
    entries: HashMap<String, (StuckToolName, Instant)>,
}

impl StuckToolTracker {
    pub(super) fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub(super) fn track_event(&mut self, event: &serde_json::Value) {
        for tool_event in events::extract_claude_tool_info(event) {
            match tool_event {
                events::ClaudeToolEvent::Use { id, name } => self.track_use(id, name),
                events::ClaudeToolEvent::Result { tool_use_id } => {
                    self.entries.remove(tool_use_id);
                }
            }
        }
    }

    fn track_use(&mut self, id: &str, name: &str) {
        let Some(name) = StuckToolName::parse(name) else {
            return;
        };

        if id.len() > MAX_TRACKED_STUCK_TOOL_ID_BYTES {
            // Tracking is auxiliary state.  Keep the event stream alive when
            // an ID cannot be retained within the watchdog bound.
            return;
        }

        if let Some((tracked_name, started)) = self.entries.get_mut(id) {
            *tracked_name = name;
            *started = Instant::now();
            return;
        }

        if self.entries.len() >= MAX_TRACKED_STUCK_TOOLS {
            // Do not evict an older call: eviction could hide a genuinely
            // stuck network request.  Once a slot is freed by its result,
            // later calls can be tracked normally again.
            return;
        }

        self.entries.insert(id.to_owned(), (name, Instant::now()));
    }

    pub(super) fn oldest_expired(&self, timeout_secs: u64) -> Option<(StuckToolName, u64)> {
        self.entries
            .values()
            .filter_map(|(name, started)| {
                let elapsed = started.elapsed().as_secs();
                (elapsed >= timeout_secs).then_some((*name, elapsed, *started))
            })
            .min_by_key(|(_, _, started)| *started)
            .map(|(name, elapsed, _)| (name, elapsed))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    fn contains_key(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }
}

pub(super) fn track_claude_tool_events(event: &serde_json::Value, tracker: &mut StuckToolTracker) {
    tracker.track_event(event)
}

#[cfg(test)]
mod tests;
