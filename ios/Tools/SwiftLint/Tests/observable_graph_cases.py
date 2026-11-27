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
          let first, // violation
            second: Computed<Int> // violation
          #if DEBUG
            let debugState = CCState.State(1) // violation
          #endif
          private(set) var query: String?
          var selectedIndex = -1
          init(graph: CCState.Store, typed: State<Int>, value: Computed<Int>) {
            self.graph = graph
            self.typed = typed
            self.value = value
            first = value
            second = value
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
          enum State { case idle, busy }
          private(set) var state: State = .idle
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
        "conditional imports and observable objects are checked",
        "okou_observable_graph",
        """
        #if DEBUG
          import CCState
          import Combine
          import Observation
          @Observable
          final class Demo {
            let state = CCState.State(0) // violation
            let value: Computed<Int> // violation
            init(value: Computed<Int>) { self.value = value }
          }
          final class Legacy: ObservableObject {
            @Published var store = CCState.Store() // violation
          }
        #endif
    """,
    ),
    (
        "native names without CCState stay valid",
        "okou_observable_graph",
        """
        import Observation
        @Observable
        final class Editor {
          struct Command { let name: String }
          var state: State? = nil
          var commands: [Command] = []
          let store = Store()
        }
        struct State {}
        final class Store {}
    """,
    ),
]
