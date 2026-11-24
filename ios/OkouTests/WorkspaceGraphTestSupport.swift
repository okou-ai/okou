import CCState

/// A fresh workspace session Store for a fixture that stands in for the workspace root.
@MainActor func makeTestWorkspaceGraph() -> CCState.Store { CCState.Store() }
