"""Original subscription/observer ownership across repeated registration."""

SUBSCRIPTION_REPLACEMENT_CASES = [
    (
        "single subscription replacement preserves the original",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscription: Subscription?
          var other: Subscription?
          func unsafe() {
            subscription = try store.watch(value) {} // violation
          }
          func wrong() {
            try? other?.cancel()
            subscription = try store.watch(value) {} // violation
          }
          func cancel() {
            try? subscription?.cancel()
            subscription = try store.watch(value) {}
          }
          func absent() {
            guard enabled, subscription == nil else { return }
            subscription = try store.watch(value) {}
          }
          func branch() {
            if subscription == nil { subscription = try store.watch(value) {} }
          }
          func flag() {
            guard !active else { return }
            subscription = try store.watch(value) {} // violation
          }
          func close() { try? subscription?.cancel() }
        }
    """,
    ),
    (
        "observer replacement removes the original from its own center",
        "okou_subscription_teardown",
        """
        import Foundation
        final class Owner {
          let center = NotificationCenter()
          var token: NSObjectProtocol?
          func unsafe() {
            token = center.addObserver(forName: event, object: nil, queue: nil) { _ in } // violation
          }
          func wrongCenter() {
            if let token { NotificationCenter.default.removeObserver(token) }
            token = center.addObserver(forName: event, object: nil, queue: nil) { _ in } // violation
          }
          func valid() {
            if let token { center.removeObserver(token) }
            token = center.addObserver(forName: event, object: nil, queue: nil) { _ in }
          }
          func absent() {
            guard token == nil else { return }
            token = center.addObserver(forName: event, object: nil, queue: nil) { _ in }
          }
          func close() { if let token { center.removeObserver(token) } }
        }
    """,
    ),
    (
        "dictionary subscription replacement distinguishes keys and aliases",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [String: Subscription] = [:]
          func unsafe(_ id: String) {
            subscriptions[id] = try store.watch(value) {} // violation
          }
          func cancel(_ id: String) {
            let key = id
            try? subscriptions[key]?.cancel()
            subscriptions[id] = try store.watch(value) {}
          }
          func wrong(_ id: String, other: String) {
            try? subscriptions[other]?.cancel()
            subscriptions[id] = try store.watch(value) {} // violation
          }
          func absent(_ id: String) {
            guard subscriptions[id] == nil else { return }
            subscriptions[id] = try store.watch(value) {}
          }
          func wrongGuard(_ id: String, other: String) {
            guard subscriptions[other] == nil else { return }
            subscriptions[id] = try store.watch(value) {} // violation
          }
          func close() {
            for subscription in subscriptions.values { try? subscription.cancel() }
          }
        }
    """,
    ),
    (
        "dictionary observer replacement preserves token and center identity",
        "okou_subscription_teardown",
        """
        import Foundation
        final class Owner {
          var tokens: [String: NSObjectProtocol] = [:]
          func replace(_ id: String) {
            if let token = tokens.removeValue(forKey: id) {
              NotificationCenter.default.removeObserver(token)
            }
            tokens[id] = NotificationCenter.default.addObserver(forName: event, object: nil, queue: nil) { _ in }
          }
          func wrong(_ id: String, other: String) {
            if let token = tokens[other] { NotificationCenter.default.removeObserver(token) }
            tokens[id] = NotificationCenter.default.addObserver(forName: event, object: nil, queue: nil) { _ in } // violation
          }
          func dropped(_ id: String) {
            tokens.removeValue(forKey: id)
            tokens[id] = NotificationCenter.default.addObserver(forName: event, object: nil, queue: nil) { _ in } // violation
          }
          func close() {
            for token in tokens.values { NotificationCenter.default.removeObserver(token) }
          }
        }
    """,
    ),
    (
        "snapshots and retained cleanup collections preserve old subscriptions",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscription: Subscription?
          var retiring: [Subscription] = []
          func snapshot() {
            let previous = subscription
            subscription = try store.watch(value) {}
            try? previous?.cancel()
          }
          func transfer() {
            if let subscription { retiring.append(subscription) }
            subscription = try store.watch(value) {}
          }
          func lostOnFailure() {
            let previous = subscription
            subscription = nil
            subscription = try store.watch(value) {} // violation
            try? previous?.cancel()
          }
          func helperFailure() {
            flag = try discardOld()
            subscription = try store.watch(value) {} // violation
          }
          private func discardOld() throws -> Bool {
            subscription = nil
            throw Failed()
          }
          func optionalFailure() {
            subscription = try? store.watch(value) {} // violation
          }
          func drop() {
            subscription = nil
            subscription = try store.watch(value) {} // violation
          }
          func conditional() {
            if enabled { try? subscription?.cancel() }
            subscription = try store.watch(value) {} // violation
          }
          func close() {
            try? subscription?.cancel()
            for old in retiring { try? old.cancel() }
          }
        }
    """,
    ),
    (
        "same owner helpers bind the requested subscription key",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [String: Subscription] = [:]
          func replace(_ id: String) {
            release(id)
            subscriptions[id] = try store.watch(value) {}
          }
          func wrong(_ id: String, other: String) {
            release(other)
            subscriptions[id] = try store.watch(value) {} // violation
          }
          func helperStorage(_ id: String) {
            release(id)
            let subscription = try store.watch(value) {}
            retain(subscription, key: id)
          }
          private func retain(_ subscription: Subscription, key: String) {
            subscriptions[key] = subscription
          }
          private func release(_ id: String) { try? subscriptions.removeValue(forKey: id)?.cancel() }
          func close() { for subscription in subscriptions.values { try? subscription.cancel() } }
        }
    """,
    ),
    (
        "every registration loop iteration preserves its preceding handle",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscription: Subscription?
          func unsafe() {
            try? subscription?.cancel()
            for value in values { subscription = try store.watch(value) {} } // violation
          }
          func safe() {
            for value in values {
              try? subscription?.cancel()
              subscription = try store.watch(value) {}
            }
          }
          func once() {
            try? subscription?.cancel()
            for value in values {
              subscription = try store.watch(value) {}
              break
            }
          }
          func close() { try? subscription?.cancel() }
        }
        final class Initializer {
          let store = CCState.Store()
          var subscription: Subscription?
          init() {
            for value in values { subscription = try store.watch(value) {} } // violation
          }
          func close() { try? subscription?.cancel() }
        }
    """,
    ),
    (
        "fresh UUID subscription keys remain independent but cannot be discarded",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [UUID: Subscription] = [:]
          func insert() {
            let id = UUID()
            subscriptions[id] = try store.watch(value) {}
          }
          func insertEach() {
            for value in values {
              let id = UUID()
              subscriptions[id] = try store.watch(value) {}
            }
          }
          func drop() {
            let id = UUID()
            subscriptions[id] = try store.watch(value) {} // violation
            subscriptions[id] = nil
          }
          func overwrite() {
            let id = UUID()
            subscriptions[id] = try store.watch(value) {} // violation
            subscriptions[id] = try store.watch(value) {}
          }
          func reused() {
            let id = UUID()
            for value in values { subscriptions[id] = try store.watch(value) {} } // violation
          }
          func close() { for subscription in subscriptions.values { try? subscription.cancel() } }
        }
    """,
    ),
    (
        "subscription shadowing cannot establish cancellation or an empty slot",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscription: Subscription?
          var subscriptions: [String: Subscription] = [:]
          func shadow(_ subscription: Subscription) {
            try? subscription.cancel()
            self.subscription = try store.watch(value) {} // violation
          }
          func shadowKey(_ id: String, other: String) {
            if enabled { let id = other; try? subscriptions[id]?.cancel() }
            subscriptions[id] = try store.watch(value) {} // violation
          }
          func mutable(_ id: String, other: String) {
            var key = id
            try? subscriptions[key]?.cancel()
            key = other
            subscriptions[key] = try store.watch(value) {} // violation
          }
          func close() {
            try? subscription?.cancel()
            for subscription in subscriptions.values { try? subscription.cancel() }
          }
        }
    """,
    ),
    (
        "new subscription aliases retain original acquisition on every branch",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [UUID: Subscription] = [:]
          func safe() {
            let first = UUID()
            let second = UUID()
            let subscription = try store.watch(value) {}
            subscriptions[first] = subscription
            subscriptions[second] = subscription
            subscriptions[first] = nil
          }
          func lost() {
            let first = UUID()
            let second = UUID()
            let subscription = try store.watch(value) {} // violation
            subscriptions[first] = subscription
            subscriptions[second] = subscription
            subscriptions[first] = nil
            subscriptions[second] = nil
          }
          func close() { for subscription in subscriptions.values { try? subscription.cancel() } }
        }
    """,
    ),
]

SUBSCRIPTION_REPLACEMENT_CASES += [
    (
        "tuple loop where guards prove only the matching slot is absent",
        "okou_subscription_teardown",
        """
        import CCState
        final class Owner {
          let store = CCState.Store()
          var subscriptions: [String: Subscription] = [:]
          func safe() {
            for (id, resource) in resources where subscriptions[id] == nil {
              subscriptions[id] = try store.watch(resource.value) {}
            }
          }
          func wrongKey() {
            for (id, other) in pairs where subscriptions[other] == nil {
              subscriptions[id] = try store.watch(value) {} // violation
            }
          }
          func flag() {
            for (id, resource) in resources where enabled {
              subscriptions[id] = try store.watch(resource.value) {} // violation
            }
          }
          func close() { for subscription in subscriptions.values { try? subscription.cancel() } }
        }
    """,
    ),
]
