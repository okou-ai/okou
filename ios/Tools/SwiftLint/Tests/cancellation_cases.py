"""Cancellation contracts exercised through the real SwiftLint CLI."""

CANCELLATION_CASES = [
    (
        "teardown is registered before suspension and remains reachable",
        "okou_resource_cancellation",
        """
        import CCState
        func makeRead(_ signal: EvaluationSignal) async -> Task<Value, Error> {
          let task = Task { try await service.load() } // violation
          await preparation.wait()
          signal.onCancel { task.cancel() }
          return task
        }
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { return; task.cancel() }
          return task
        }
        final class Owner {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() } // violation
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { return; current?.cancel() }
        }
    """,
    ),
    (
        "signal aliases retain the current evaluation identity",
        "okou_resource_cancellation",
        """
        import CCState
        func makeRead(_ signal: EvaluationSignal) -> Task<Value, Error> {
          let lifetime = signal
          let task = Task { try await service.load() }
          lifetime.onCancel { task.cancel() }
          return task
        }
        let read = Computed { get, options in
          let options = unrelated
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { task.cancel() }
          return task
        }
    """,
    ),
    (
        "local teardown snapshots refer to the original handle",
        "okou_resource_cancellation",
        """
        import CCState
        final class Owner {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() }
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { let original = self.current; original?.cancel() }
        }
        final class WrongTarget {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() } // violation
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { let current = unrelated; current.cancel() }
        }
    """,
    ),
    (
        "proven same-owner helpers and evaluation signals",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var closed = false
          var generation = 0
          var title = ""
          func check(_ expected: Int) throws {
            try Task.checkCancellation()
            guard generation == expected else { throw CancellationError() }
          }
          let write = asyncCommand { context, value in
            await service.load()
            try check(generation)
            try context.set(saved, value)
          }
          let read = Computed { get, options in
            let signal = options.signal
            let task = Task {
              let result = await service.load()
              guard !signal.isCancelled else { return }
              self.title = result.title
              await service.refresh()
              try signal.checkCancellation()
              self.title = result.title
            }
            return task
          }
        }
    """,
    ),
    (
        "helper names and input signals are not cancellation proofs",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var title = ""
          func check() throws { record("checked") }
          let write = asyncCommand { context, payload in
            let signal = payload.signal
            await service.load()
            try signal.checkCancellation()
            try context.set(saved, payload) // violation
            try check()
            self.title = "Stale" // violation
          }
        }
    """,
    ),
    (
        "local shadowing does not hide explicit owner writes",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var closed = false
          var title = ""
          var snapshot = Snapshot()
          let read = Computed { get, options in
            Task {
              let closed = false
              let title = "Local"
              await service.load()
              guard !closed else { return }
              self.title = title // violation
              self.snapshot.title = title // violation
              guard !self.closed else { return }
              self.title = title
            }
          }
        }
    """,
    ),
    (
        "switch and repeated suspension paths",
        "okou_check_after_await",
        """
        import CCState
        let write = asyncCommand { context, value in
          await service.load()
          switch mode {
          case .ready: try Task.checkCancellation()
          default: return
          }
          try context.set(saved, value)
          for item in values {
            await service.save(item)
            try context.set(saved, value) // violation
            try Task.checkCancellation()
            try context.set(saved, value)
          }
        }
    """,
    ),
    (
        "wrong and conditional owner teardown cannot release the original",
        "okou_resource_cancellation",
        """
        import CCState
        final class WrongTarget {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() } // violation
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close(_ current: Task<Value, Error>) { current.cancel() }
        }
        final class Conditional {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() } // violation
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { if enabled { current?.cancel() } }
        }
    """,
    ),
    (
        "publication after suspension",
        "okou_check_after_await",
        """
        import CCState
        let write = asyncCommand { context, value in
          await service.save(value)
          try context.set(saved, value) // violation
          try Task.checkCancellation()
          try context.set(confirmed, value)
          await service.refresh()
          if ready { try Task.checkCancellation() }
          try context.set(saved, value) // violation
        }
    """,
    ),
    (
        "causal cancellation checks",
        "okou_check_after_await",
        """
        import CCState
        let write = asyncCommand { context, value in
          await service.save(value)
          guard !Task.isCancelled else { return }
          try context.set(saved, value)
          await service.refresh()
          if Task.isCancelled { return }
          try context.set(saved, value)
          await service.refresh()
          if !Task.isCancelled { try context.set(saved, value) }
        }
    """,
    ),
    (
        "checks must dominate publication",
        "okou_check_after_await",
        """
        import CCState
        let write = asyncCommand { context, value in
          try Task.checkCancellation()
          await service.save(value)
          try context.set(saved, value) // violation
          try? Task.checkCancellation()
          try context.set(saved, value) // violation
          guard !Task.isCancelled || force else { return }
          try context.set(saved, value) // violation
        }
    """,
    ),
    (
        "owner identity and local values",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var generation = 0
          var closed = false
          var title = ""
          let read = Computed { get, options in
            let task = Task {
              let request = generation
              let result = await service.load()
              title = result.title // violation
              guard !closed, request == generation else { return }
              title = result.title
              var local = await service.load()
              local.title = "Local projection"
              guard request == generation else { return }
              self.title = local.title
            }
            return task
          }
        }
    """,
    ),
    (
        "branch and catch checks do not escape",
        "okou_check_after_await",
        """
        import CCState
        let write = asyncCommand { context, value in
          do {
            await service.save(value)
            try Task.checkCancellation()
            try context.set(saved, value)
          } catch {
            try context.set(saved, value) // violation
          }
          try context.set(saved, value) // violation
        }
        let write = asyncCommand { context, value in
          await service.save(value)
          if enabled { try Task.checkCancellation() }
          else { throw CancellationError() }
          try context.set(saved, value)
        }
    """,
    ),
    (
        "nested scopes and teardown",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var working = false
          let read = Computed { get, options in
            let task = Task {
              defer { working = false }
              return await service.load()
            }
            return task
          }
        }
        let write = asyncCommand { context, value in
          installCallback { await service.load() }
          try context.set(saved, value)
          let nested = { await service.load() }
          try context.set(saved, value)
        }
    """,
    ),
    (
        "resource Task requires its own cancellation hook",
        "okou_resource_cancellation",
        """
        import CCState
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          return task
        }
        let read = Computed { get, options in
          return Task { try await service.load() } // violation
        }
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { other.cancel() }
          return task
        }
    """,
    ),
    (
        "original Task and signal aliases",
        "okou_resource_cancellation",
        """
        import CCState
        let read = Computed { get, options in
          let signal = options.signal
          let lifetime = signal
          let task = Task.immediate { try await service.load() }
          let original = task
          lifetime.onCancel { original.cancel() }
          return task
        }
        func makeRead(_ signal: EvaluationSignal) -> Task<Value, Error> {
          let task = Task { try await service.load() }
          signal.onCancel { task.cancel() }
          return task
        }
    """,
    ),
    (
        "shared reads keep their original owner",
        "okou_resource_cancellation",
        """
        import CCState
        let projection = computedTask { get, options in
          let shared = try get(resource)
          let value = try await shared.value
          try Task.checkCancellation()
          try options.signal.checkCancellation()
          return transform(value)
        }
        let read = Computed { get, options in
          guard enabled else { return Task { [] } }
          let task = Task { try await service.load() }
          options.signal.onCancel { task.cancel() }
          return task
        }
    """,
    ),
    (
        "registration and cancellation must be unconditional",
        "okou_resource_cancellation",
        """
        import CCState
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          if enabled { options.signal.onCancel { task.cancel() } }
          return task
        }
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { if enabled { task.cancel() } }
          return task
        }
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { let task = other; task.cancel() }
          return task
        }
        let read = Computed { get, options in
          let task = Task { try await service.load() } // violation
          return task
          options.signal.onCancel { task.cancel() }
        }
    """,
    ),
    (
        "retained resource Task has explicit owner teardown",
        "okou_resource_cancellation",
        """
        import CCState
        final class Owner {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() }
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { cancelRead() }
          private func cancelRead() { current?.cancel(); current = nil }
        }
        final class Leaked {
          var current: Task<Value, Error>?
          let read = Computed { get, options in
            let task = Task { try await service.load() } // violation
            current = task
            options.signal.onCancel { task.cancel() }
            return task
          }
          func close() { current = nil }
          deinit { current?.cancel() }
        }
    """,
    ),
]
