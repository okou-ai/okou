"""Observation keeps native interaction state; graph signals and Stores stay out of it."""

OBSERVABLE_GRAPH_CASES = [
    (
        "observable owners cannot store graph signals or Stores",
        "okou_observable_graph",
        """
        import CCState
        import Observation
        @MainActor @Observable
        final class Owner {
          let graph: CCState.Store // violation
          @ObservationIgnored private let state = CCState.State(0) // violation
          private let typed: State<Int> // violation
          let value: Computed<Int> // violation
          let reads: [String: Computed<Int>] = [:] // violation
          private(set) var query: String?
          var selectedIndex = -1
          init(graph: CCState.Store, typed: State<Int>, value: Computed<Int>) {
            self.graph = graph
            self.typed = typed
            self.value = value
          }
        }
    """,
    ),
    (
        "observable owners may hold native state and return existing signals",
        "okou_observable_graph",
        """
        import CCState
        import Observation
        @MainActor @Observable
        final class Flow {
          private(set) var busy = false
          private let resources: Resources
          var summary: Computed<Int> { resources.summary }
          init(graph: CCState.Store) { resources = Resources(graph: graph) }
        }
        @MainActor
        final class Resources {
          let store: CCState.Store
          private let count = CCState.State(0)
          let summary: Computed<Int>
          init(graph: CCState.Store) {
            store = graph
            let count = count
            summary = Computed { try $0(count) }
          }
        }
    """,
    ),
    (
        "graph owners outside Observation keep their signals",
        "okou_observable_graph",
        """
        import CCState
        @MainActor
        final class Store {
          private let status = CCState.State(0)
          let statusValue: Computed<Int>
          init() {
            let status = status
            statusValue = Computed { try $0(status) }
          }
        }
    """,
    ),
]
