"""Application sources do not subscribe to a CCState Store; test waiters may."""

APPLICATION_SUBSCRIPTION_CASES = [
    (
        "application owners read graph values instead of subscribing",
        "Okou/Features/ChatList/Owner.swift",
        """
        import CCState
        final class Owner {
          let store: CCState.Store
          var subscription: Subscription?
          func activate() throws {
            subscription = try store.watch(value) { refresh() } // violation
            let local = try resources.store.watch(other) {} // violation
            defer { try? local.cancel() }
            _ = try store.get(value)
          }
        }
        """,
    ),
    (
        "package sources follow the same contract",
        "Packages/ChatData/Sources/ChatData/Reader.swift",
        """
        import CCState
        func observe(_ store: Store) throws -> Subscription {
          try store.watch(value) {} // violation
        }
        """,
    ),
    (
        "test waiters may watch a signal",
        "OkouTests/BusinessTestWaitSupport.swift",
        """
        import CCState
        func wait(_ store: CCState.Store) throws {
          let subscription = try store.watch(value) {}
          defer { try? subscription.cancel() }
        }
        """,
    ),
    (
        "sources without CCState have no graph subscriptions",
        "Okou/Features/Other/Folder.swift",
        """
        import Foundation
        let token = folder.watch(path) {}
        """,
    ),
]
