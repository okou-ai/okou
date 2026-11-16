"""Graph identity is checked at construction and visible factory call sites."""

GRAPH_FACTORY_CASES = [
    (
        "free factories cannot rebuild graphs during repeated execution",
        """
        import CCState
        func makeRead(_ value: Int) -> Computed<Int> {
          Computed { _ in value }
        }
        let action = Command { context in
          let child = makeRead(1) // violation
        }
        let read = Computed { get in
          let child = makeRead(1) // violation
          return try get(child)
        }
        final class Owner {
          func refresh() { let child = makeRead(1) } // violation
          var current: Computed<Int> { makeRead(1) } // violation
        }
    """,
    ),
    (
        "getters cannot directly construct fresh graph identities",
        """
        import CCState
        final class Owner {
          var read: Computed<Int> { Computed { _ in 1 } } // violation
          var explicit: Computed<Int> {
            get { return CCState.Computed<Int> { _ in 1 } } // violation
          }
          var store: CCState.Store { CCState.Store() } // violation
          var action: Command<Void, Void> {
            Command { context in } // violation
          }
        }
    """,
    ),
    (
        "owner initializers lazy storage and borrowed getters stay valid",
        """
        import CCState
        func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        let shared = makeRead(1)
        final class Owner {
          let read: Computed<Int>
          lazy var deferred = makeRead(2)
          init() { read = makeRead(1) }
          var borrowed: Computed<Int> { read }
          var borrowedLazy: Computed<Int> { deferred }
          func existing() -> Computed<Int> { read }
          func refresh() { let read = existing() }
        }
        func makeOwner() -> Owner { Owner() }
        let action = Command { context in let owner = makeOwner() }
    """,
    ),
    (
        "same owner and named type factories follow the actual receiver",
        """
        import CCState
        final class Owner {
          private func buildRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
          static func createRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
          func refresh() {
            let first = buildRead(1) // violation
            let second = self.buildRead(1) // violation
            let third = Self.createRead(1) // violation
            let fourth = Factory.read(1) // violation
            let foreign = service.buildRead(1)
          }
        }
        enum Factory {
          static func read(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        }
        final class Other {
          let existing = Computed { _ in 0 }
          func buildRead(_ value: Int) -> Computed<Int> { existing }
          func refresh() { let borrowed = buildRead(1) }
        }
    """,
    ),
    (
        "local bindings and parameters shadow a graph factory",
        """
        import CCState
        func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        func run(_ makeRead: (Int) -> Int) { let value = makeRead(1) }
        func refresh() {
          let makeRead = { (value: Int) in value }
          let value = makeRead(1)
        }
        let action = Command { context in
          let makeRead = { (value: Int) in value }
          let value = makeRead(1)
        }
        let callback = { (makeRead: (Int) -> Int) in makeRead(1) }
        let captured = { [makeRead = service.lookup] in makeRead(1) }
        func optional(_ source: ((Int) -> Int)?) {
          if let makeRead = source { let value = makeRead(1) }
          guard let makeRead = source else { return }
          let value = makeRead(1)
        }
        func loop(_ readers: [(Int) -> Int]) {
          for makeRead in readers { let value = makeRead(1) }
        }
        func matching(_ reader: Reader) {
          if case let .callback(makeRead) = reader { let value = makeRead(1) }
          switch reader {
          case let .callback(makeRead): let value = makeRead(1)
          default: break
          }
        }
        final class Owner {
          let makeRead = { (value: Int) in value }
          func refresh() { let value = makeRead(1) }
        }
    """,
    ),
    (
        "overridable methods are not assumed to construct new graphs",
        """
        import CCState
        class Base {
          func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
          func refresh() { let read = self.makeRead(1) }
        }
        final class Cached: Base {
          let cached = Computed { _ in 0 }
          override func makeRead(_ value: Int) -> Computed<Int> { cached }
        }
        class Fixed {
          private func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
          func refresh() { let read = self.makeRead(1) } // violation
        }
    """,
    ),
    (
        "argument labels distinguish factories and borrowed overloads",
        """
        import CCState
        let shared = Computed { _ in 1 }
        func read(new value: Int) -> Computed<Int> { Computed { _ in value } }
        func read(existing value: Int) -> Computed<Int> { shared }
        func ambiguous(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        func ambiguous(_ value: String) -> Computed<Int> { shared }
        func refresh() {
          let fresh = read(new: 1) // violation
          let borrowed = read(existing: 1)
          let unresolved = ambiguous(1)
        }
    """,
    ),
    (
        "defaults and variadics do not hide potentially borrowed overloads",
        """
        import CCState
        let shared = Computed { _ in 1 }
        func read(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        func read(_ value: String, title: String = "") -> Computed<Int> { shared }
        func pair(_ left: Int, _ right: Int) -> Computed<Int> { Computed { _ in left + right } }
        func pair(_ values: String...) -> Computed<Int> { shared }
        func refresh() {
          let borrowed = read("name")
          let borrowedPair = pair("first", "second")
        }
    """,
    ),
    (
        "factories can be declared later or inside the current lexical scope",
        """
        import CCState
        let action = Command { context in
          let child = build(1) // violation
          func build(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        }
        func refresh() { let child = later(1) } // violation
        func later(_ value: Int) -> Computed<Int> { return Computed { _ in value } }
        func localOwner() {
          func later(_ value: Int) -> Int { value }
          let native = later(1)
        }
    """,
    ),
    (
        "factory returns distinguish construction from cache reads",
        """
        import CCState
        let shared = Computed { _ in 1 }
        func fresh(_ value: Int) -> Computed<Int> {
          let input = value
          return Computed { _ in input }
        }
        func selected(_ value: Bool) -> Computed<Int> {
          if value { return Computed { _ in 1 } }
          return Computed { _ in 2 }
        }
        func cached(_ value: Bool) -> Computed<Int> {
          if value { return shared }
          return Computed { _ in 2 }
        }
        func borrowed() -> Computed<Int> { shared }
        func refresh() {
          let first = fresh(1) // violation
          let second = selected(true) // violation
          let third = cached(true)
          let fourth = borrowed()
        }
    """,
    ),
    (
        "rendering and native action callbacks cannot call graph factories",
        """
        import CCState
        import SwiftUI
        func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        struct Screen: View {
          var body: some View {
            let read = makeRead(1) // violation
            Button("Refresh") { let read = makeRead(1) } // violation
          }
          @ViewBuilder func makeContent() -> some View {
            let read = makeRead(1) // violation
            Text("Content")
          }
        }
        final class Adapter {
          func updateUIView(_ view: UIView, context: Context) {
            let read = makeRead(1) // violation
          }
        }
    """,
    ),
    (
        "test invocations own fixtures but their repeated callbacks remain checked",
        """
        import CCState
        import XCTest
        func makeRead(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        final class OwnerTests: XCTestCase {
          func testRead() {
            let read = makeRead(1)
            let action = Command { context in
              let read = makeRead(1) // violation
            }
          }
        }
        @Test func readsValue() {
          let read = makeRead(1)
          let computed = Computed { get in
            let read = makeRead(1) // violation
            return try get(read)
          }
        }
    """,
    ),
    (
        "qualified factory names respect local type name shadowing",
        """
        import CCState
        enum Factory {
          static func read(_ value: Int) -> Computed<Int> { Computed { _ in value } }
        }
        func run(_ Factory: Service) { let value = Factory.read(1) }
        func refresh() {
          let Factory = service
          let value = Factory.read(1)
        }
    """,
    ),
]
