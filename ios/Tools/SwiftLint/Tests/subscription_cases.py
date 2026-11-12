"""Subscription ownership contracts exercised through the real SwiftLint CLI."""

SUBSCRIPTION_CASES = [
    (
        "local subscriptions are released on scope exit",
        "okou_subscription_teardown",
        """
        import CCState
        let store = CCState.Store()
        func scoped() async throws {
          let subscription = try store.watch(value) {}
          defer { try? subscription.cancel() }
          await operation()
        }
        func missing() throws {
          let subscription = try store.watch(value) {} // violation
        }
        func wrong() throws {
          let subscription = try store.watch(value) {} // violation
          try other.cancel()
        }
        func aliased() throws {
          let subscription = try store.watch(value) {}
          let original = subscription
          defer { try? original.cancel() }
        }
    """,
    ),
    (
        "retained subscriptions close through their actual owner",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() {
            do { try subscription?.cancel() } catch { report(error) }
            subscription = nil
          }
        }
        final class Leaked {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          deinit { try? subscription?.cancel() }
        }
        final class Uncalled {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func cleanup() { try? subscription?.cancel() }
          func close() {}
        }
    """,
    ),
    (
        "collection transfer retains the original subscriptions",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws {
            let first = try store.watch(one) {}
            let alias = first
            subscriptions.append(alias)
            let second = try store.watch(two) {}
            subscriptions.append(second)
          }
          func close() { stopObserving() }
          func stopObserving() {
            for subscription in subscriptions { try? subscription.cancel() }
            subscriptions.removeAll()
          }
        }
        final class Lost {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws {
            let first = try store.watch(one) {} // violation
            subscriptions.append(first)
          }
          func close() { subscriptions.removeAll() }
        }
    """,
    ),
    (
        "dictionary owners and async close use synchronous cleanup first",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [String: Subscription] = [:]
          func start(_ id: String) throws {
            try? subscriptions[id]?.cancel()
            subscriptions[id] = try store.watch(value) {}
          }
          func detach() {
            for subscription in subscriptions.values { try? subscription.cancel() }
            subscriptions = [:]
          }
          func close() async {
            detach()
            await tasksComplete()
          }
        }
    """,
    ),
    (
        "cleanup cannot be hidden behind unrelated conditions or early returns",
        "okou_subscription_teardown",
        """
        import CCState
        final class Conditional {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() { if shouldStop { try? subscription?.cancel() } }
        }
        final class Guarded {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func stop() {
            guard shouldStop else { return }
            try? subscription?.cancel()
          }
        }
        final class Unreachable {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() {
            return;
            try? subscription?.cancel()
          }
        }
        final class Both {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() {
            if alternate { try? subscription?.cancel() }
            else { try? self.subscription?.cancel() }
          }
        }
    """,
    ),
    (
        "shadowed handles and discarded closures do not cancel originals",
        "okou_subscription_teardown",
        """
        import CCState
        final class Shadowed {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() {
            let subscription = otherSubscription
            try? subscription.cancel()
          }
        }
        final class DeferredClosure {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() {
            let cleanup = { try? self.subscription?.cancel() }
          }
        }
        final class Overwritten {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() {
            subscription = nil
            try? subscription?.cancel()
          }
        }
    """,
    ),
    (
        "optional snapshots can outlive a cleared field until cancellation",
        "okou_subscription_teardown",
        """
        import CCState
        final class Snapshot {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() {
            let original = subscription
            subscription = nil
            try? original?.cancel()
          }
        }
        final class Unwrapped {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() {
            guard let subscription else { return }
            try? subscription.cancel()
          }
        }
    """,
    ),
    (
        "helpers bind original arguments and resolve overloads conservatively",
        "okou_subscription_teardown",
        """
        import CCState
        final class Helper {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() { release(subscription) }
          func release(_ original: Subscription?) { try? original?.cancel() }
        }
        final class Ambiguous {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() { release(subscription) }
          func release(_ value: Subscription?) { try? value?.cancel() }
          func release(_ value: OtherHandle?) {}
        }
        final class Recursion {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() { cleanup() }
          func cleanup() { close() }
        }
    """,
    ),
    (
        "block observer cleanup targets the original token and center",
        "okou_subscription_teardown",
        """
        import Foundation
        func valid() {
          let token = NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in }
          defer { NotificationCenter.default.removeObserver(token) }
        }
        func wrong() {
          let token = NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in } // violation
          NotificationCenter.default.removeObserver(other)
        }
        func wrongCenter() {
          let center = NotificationCenter()
          let token = center.addObserver(forName: event, object: nil, queue: .main) { _ in } // violation
          NotificationCenter.default.removeObserver(token)
        }
    """,
    ),
    (
        "observer collections stop under the original owner",
        "okou_subscription_teardown",
        """
        import Foundation
        final class Capture {
          var observers: [NSObjectProtocol] = []
          func start() {
            observers = [
              NotificationCenter.default.addObserver(forName: first, object: nil, queue: .main) { _ in },
              NotificationCenter.default.addObserver(forName: second, object: nil, queue: .main) { _ in },
            ]
          }
          func stop() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
          }
        }
        final class Wrong {
          var observers: [NSObjectProtocol] = []
          func start() {
            observers.append(NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in }) // violation
          }
          func stop() {
            for other in otherObservers { NotificationCenter.default.removeObserver(other) }
            observers = []
          }
        }
    """,
    ),
    (
        "native controller lifetime and selector observers retain native semantics",
        "okou_subscription_teardown",
        """
        import UIKit
        final class Controller: UIViewController {
          var token: NSObjectProtocol?
          override func viewDidLoad() {
            guard token == nil else { return }
            token = NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in }
          }
          deinit { if let token { NotificationCenter.default.removeObserver(token) } }
        }
        final class BusinessOwner {
          var token: NSObjectProtocol?
          init() {
            token = NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in } // violation
          }
          deinit { if let token { NotificationCenter.default.removeObserver(token) } }
        }
        final class Selector: NSObject {
          override init() {
            super.init()
            NotificationCenter.default.addObserver(self, selector: #selector(changed), name: event, object: nil)
          }
        }
    """,
    ),
    (
        "foreach and explicit transfer preserve caller ownership",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws { subscriptions.append(try store.watch(value) {}) }
          func close() { subscriptions.forEach { try? $0.cancel() } }
        }
        func makeSubscription(store: CCState.Store) throws -> Subscription {
          return try store.watch(value) {}
        }
        func otherAPI(service: Service) { let observation = service.watch(value) {} }
    """,
    ),
]

SUBSCRIPTION_CASES += [
    (
        "XCTest owns registered cleanup without broad test exemptions",
        "okou_subscription_teardown",
        """
        import CCState
        import XCTest
        final class Tests: XCTestCase {
          let store = CCState.Store()
          func testObserved() async throws {
            let subscription = try store.watch(value) {}
            addTeardownBlock { @MainActor in
              try subscription.cancel()
              await operation()
            }
            await operation()
          }
        }
        final class Unowned {
          let store = CCState.Store()
          func start() throws {
            let subscription = try store.watch(value) {} // violation
            addTeardownBlock { try subscription.cancel() }
          }
          func addTeardownBlock(_ body: () throws -> Void) {}
        }
    """,
    ),
    (
        "owner cleanup runs before unrelated nil-resource exits",
        "okou_subscription_teardown",
        """
        import Foundation
        final class Capture {
          var engine: Engine?
          var observers: [NSObjectProtocol] = []
          func start() {
            observers = [NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in }]
          }
          func stop() {
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers.removeAll()
            guard let engine else { return }
            engine.stop()
          }
        }
        final class EarlyExit {
          var engine: Engine?
          var token: NSObjectProtocol?
          func start() {
            token = NotificationCenter.default.addObserver(forName: event, object: nil, queue: .main) { _ in } // violation
          }
          func stop() {
            guard let engine else { return }
            if let token { NotificationCenter.default.removeObserver(token) }
          }
        }
    """,
    ),
]

SUBSCRIPTION_CASES += [
    (
        "collection cleanup must visit every retained handle",
        "okou_subscription_teardown",
        """
        import CCState
        final class Broken {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws { subscriptions.append(try store.watch(value) {}) } // violation
          func close() {
            for subscription in subscriptions {
              try? subscription.cancel()
              break
            }
          }
        }
        final class Returning {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws { subscriptions.append(try store.watch(value) {}) } // violation
          func close() {
            for subscription in subscriptions {
              try? subscription.cancel()
              return
            }
          }
        }
        final class Continuing {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws { subscriptions.append(try store.watch(value) {}) }
          func close() {
            for subscription in subscriptions {
              try? subscription.cancel()
              continue
            }
          }
        }
    """,
    ),
    (
        "throwing prerequisites cannot bypass cleanup",
        "okou_subscription_teardown",
        """
        import CCState
        final class Lost {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() throws {
            try service.finish()
            try subscription?.cancel()
          }
        }
        final class Deferred {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} }
          func close() throws {
            defer { try? subscription?.cancel() }
            try service.finish()
          }
        }
    """,
    ),
    (
        "XCTest captures retain snapshots while deferred variables remain live",
        "okou_subscription_teardown",
        """
        import CCState
        import XCTest
        final class Tests: XCTestCase {
          let store = CCState.Store()
          func testSnapshot() throws {
            var subscription = try store.watch(value) {}
            addTeardownBlock { [subscription] in try subscription.cancel() }
            subscription = other
          }
          func testWrongLiveValue() throws {
            var subscription = try store.watch(value) {} // violation
            defer { try? subscription.cancel() }
            subscription = other
          }
        }
    """,
    ),
    (
        "unrelated watch methods and local store shadows remain unrelated",
        "okou_subscription_teardown",
        """
        import CCState
        let store = CCState.Store()
        func feature(store: WatchService) {
          let value = store.watch(input) {}
        }
        func localShadow() {
          let store = WatchService()
          let value = store.watch(input) {}
        }
        final class Other {
          let store = WatchService()
          func start() { let value = store.watch(input) {} }
        }
    """,
    ),
    (
        "immutable center aliases retain the same observer identity",
        "okou_subscription_teardown",
        """
        import Foundation
        func valid() {
          let center = NotificationCenter.default
          let alias = center
          let token = alias.addObserver(forName: event, object: nil, queue: .main) { _ in }
          defer { center.removeObserver(token) }
        }
        func leaked() {
          let center = NotificationCenter.default
          let alias = center
          let token = alias.addObserver(forName: event, object: nil, queue: .main) { _ in } // violation
        }
    """,
    ),
    (
        "evaluation signals own registered subscription cleanup",
        "okou_subscription_teardown",
        """
        import CCState
        let store = CCState.Store()
        let read = Computed { get, options in
          let subscription = try store.watch(value) {}
          options.signal.onCancel { try? subscription.cancel() }
          return try get(value)
        }
        func unknown() throws {
          let subscription = try store.watch(value) {} // violation
          service.onCancel { try? subscription.cancel() }
        }
    """,
    ),
]

SUBSCRIPTION_CASES += [
    (
        "shadowed test cleanup APIs do not inherit framework ownership",
        "okou_subscription_teardown",
        """
        import CCState
        import XCTest
        final class Tests: XCTestCase {
          let store = CCState.Store()
          func testLocalShadow() throws {
            func addTeardownBlock(_ body: () -> Void) {}
            let subscription = try store.watch(value) {} // violation
            addTeardownBlock { try? subscription.cancel() }
          }
        }
        final class OtherTests: XCTestCase {
          let store = CCState.Store()
          func testHelperShadow() throws {
            let subscription = try store.watch(value) {} // violation
            addTeardownBlock { try? subscription.cancel() }
          }
          func addTeardownBlock(_ body: () -> Void) {}
        }
    """,
    ),
    (
        "compound optional guards and filtered loops do not establish full cleanup",
        "okou_subscription_teardown",
        """
        import CCState
        final class Guarded {
          let store = CCState.Store()
          var subscription: Subscription?
          init() throws { subscription = try store.watch(value) {} } // violation
          func close() {
            if let subscription, shouldStop { try? subscription.cancel() }
          }
        }
        final class Filtered {
          let store = CCState.Store()
          var subscriptions: [Subscription] = []
          init() throws { subscriptions.append(try store.watch(value) {}) } // violation
          func close() {
            for subscription in subscriptions where shouldStop { try? subscription.cancel() }
          }
        }
    """,
    ),
]
