"""Caught-error aliases and explicit switch paths retain cancellation semantics."""

RESOURCE_FAILURE_PATH_CASES = [
    (
        "immutable error aliases cannot publish cancelled reads",
        "okou_resource_failures",
        """
        import CCState
        let direct = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cause = error
            if cause is CancellationError { return [] }
            throw error
          }
        }
        let chained = computedTask { get, options in
          do { return try await service.load() }
          catch let failure { // violation
            let original = (failure)
            let cause = original
            if cause is _Concurrency.CancellationError { return nil }
            throw failure
          }
        }
        let transport = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError { // violation
            let cause = failure
            if cause.code == .cancelled { return [:] }
            throw failure
          }
        }
    """,
    ),
    (
        "boolean aliases preserve positive and negative cancellation paths",
        "okou_resource_failures",
        """
        import CCState
        let direct = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cancelled = error is CancellationError
            if cancelled { return [] }
            throw error
          }
        }
        let guarded = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let active = !Task.isCancelled
            let mayContinue = active
            guard mayContinue else { return nil }
            throw error
          }
        }
        let evaluation = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cancelled = options.signal.isCancelled
            if cancelled == true && shouldStop { return [] }
            throw error
          }
        }
    """,
    ),
    (
        "typed cancellation switch cases cannot return successful data",
        "okou_resource_failures",
        """
        import CCState
        let direct = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            switch error {
            case is CancellationError: return []
            default: throw error
            }
          }
        }
        let alias = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cause = error
            switch cause {
            case let cancelled as _Concurrency.CancellationError:
              record(cancelled)
              return nil
            default: throw error
            }
          }
        }
    """,
    ),
    (
        "URL code switches distinguish cancellation from transport recovery",
        "okou_resource_failures",
        """
        import CCState
        import Foundation
        let typed = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError { // violation
            let cause = failure
            switch cause.code {
            case .cancelled: return []
            case .notConnectedToInternet: return cached
            default: throw failure
            }
          }
        }
        let optional = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cause = error
            switch (cause as? Foundation.URLError)?.code {
            case .some(.cancelled): return nil
            default: throw error
            }
          }
        }
    """,
    ),
    (
        "boolean switch cases retain cancellation polarity",
        "okou_resource_failures",
        """
        import CCState
        let positive = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cancelled = error is CancellationError
            switch cancelled {
            case true: return []
            case false: throw error
            }
          }
        }
        let negative = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let active = !Task.isCancelled
            switch active {
            case false: return nil
            case true: throw error
            }
          }
        }
    """,
    ),
    (
        "mutable aliases unrelated flags and shadowed names prove nothing",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            var cause = error
            cause = cachedFailure
            if cause is CancellationError { return [] }
            var cancelled = Task.isCancelled
            cancelled = owner.finished
            if cancelled { return [] }
            let snapshot = error
            if let snapshot = cachedFailure {
              if snapshot is CancellationError { return [] }
            }
            let flag = Task.isCancelled
            for flag in businessFlags {
              if flag { return [] }
            }
            switch cachedResult {
            case let .value(flag):
              if flag { return [] }
            default: break
            }
            if case let .value(flag) = cachedResult, flag { return [] }
            guard let flag = optionalBusinessFlag else { throw error }
            if flag { return [] }
            throw error
          }
        }
    """,
    ),
    (
        "alias snapshots keep their original lexical error binding",
        "okou_resource_failures",
        """
        import CCState
        let original = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cause = error
            if useCached {
              let error = cachedFailure
              if cause is CancellationError { return [] }
            }
            throw error
          }
        }
        let unrelated = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if useCached {
              let error = cachedFailure
              let cause = error
              if cause is CancellationError { return [] }
            }
            throw error
          }
        }
    """,
    ),
    (
        "noncancelled recovery rethrows and alias-owned cleanup remain valid",
        "okou_resource_failures",
        """
        import CCState
        let recovery = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let cancelled = error is CancellationError
            guard !cancelled else { throw error }
            return cached
          }
        }
        let cleanup = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let original = error
            try? await allocated.close()
            throw original
          }
        }
        let switched = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let cause = error
            switch cause {
            case is CancellationError: throw cause
            case is MissingOptionalResource: return []
            default: throw cause
            }
          }
        }
        let retry = computedTask { get, options in
          do { return try await service.load() }
          catch {
            switch error {
            case is CancellationError: return try await service.retry()
            default: throw error
            }
          }
        }
    """,
    ),
    (
        "switch labels and unrelated subjects cannot invent cancellation",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            switch cachedFailure {
            case is CancellationError: return []
            default: break
            }
            switch error {
            case is CancellationError where false: return []
            case is MissingOptionalResource: return []
            default: throw error
            }
          }
        }
        let domain = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as DomainError {
            switch failure.code {
            case .cancelled: return []
            default: throw failure
            }
          }
        }
    """,
    ),
    (
        "known cancellation names must retain their lexical owner",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let Task = businessState
            let cancelled = Task.isCancelled
            if cancelled { return [] }
            let (error, detail) = cachedFailure
            let cause = error
            if cause is CancellationError { return [] }
            throw owner.failure
          }
        }
        let loop = computedTask { get, options in
          do { return try await service.load() }
          catch {
            while let error = nextBusinessFailure() {
              let cancelled = error is CancellationError
              if cancelled { return [] }
              break
            }
            throw error
          }
        }
    """,
    ),
    (
        "same declaration aliases and explicit where checks retain cancellation",
        "okou_resource_failures",
        """
        import CCState
        let declaration = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cause = error, cancelled = cause is CancellationError
            if cancelled { return [] }
            throw error
          }
        }
        let guarded = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cancelled = error is CancellationError
            switch owner.phase {
            case .ready where cancelled: return []
            default: throw error
            }
          }
        }
    """,
    ),
    (
        "unreachable alias conditions and unknown helper predicates prove nothing",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let disabled = false
            let cancelled = error is CancellationError
            if disabled && cancelled { return [] }
            if !disabled || cancelled { throw error } else { return [] }
            let unknown = owner.isCancellation(error)
            if unknown { return [] }
            throw error
          }
        }
        let foreignCleanup = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let original = cachedFailure
            try? await allocated.close() // violation
            throw original
          }
        }
        let shadowedCleanup = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let error = cachedFailure
            try? await allocated.close() // violation
            throw error
          }
        }
    """,
    ),
    (
        "grouped direct and aliased cancellation checks retain their meaning",
        "okou_resource_failures",
        """
        import CCState
        let direct = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if GROUPED_CANCELLED { return [] }
            throw error
          }
        }
        let aliased = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            let cancelled = GROUPED_CANCELLED
            if cancelled { return [] }
            throw error
          }
        }
    """.replace("GROUPED_CANCELLED", "(" * 20 + "Task.isCancelled" + ")" * 20),
    ),
    (
        "native commands completion bridges and deferred callbacks keep their contracts",
        "okou_resource_failures",
        """
        import CCState
        let action = asyncCommand { context in
          do { try await service.save() }
          catch {
            let cancelled = error is CancellationError
            if cancelled { return }
            throw error
          }
        }
        func makeCompletion() -> Computed<Task<Void, Never>> {
          Computed { get in
            Task {
              do { try await service.finish() }
              catch {
                switch error {
                case is CancellationError: return
                default: owner.report(error)
                }
              }
            }
          }
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            let callback = {
              let cancelled = error is CancellationError
              if cancelled { return [] }
              return cached
            }
            throw error
          }
        }
    """,
    ),
]
