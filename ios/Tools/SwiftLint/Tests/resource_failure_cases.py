"""Cancellation returns and legitimate recovery through real CLI diagnostics."""

RESOURCE_FAILURE_CASES = [
    (
        "cancellation tests inside a catch cannot publish empty data",
        "okou_resource_failures",
        """
        import CCState
        import Foundation
        let values = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if error is CancellationError { return [] }
            throw error
          }
        }
        let optional = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if Task.isCancelled { return nil }
            throw error
          }
        }
        let mapping = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if error is _Concurrency.CancellationError || Swift.Task.isCancelled { return [:] }
            throw error
          }
        }
    """,
    ),
    (
        "URL cancellation is distinct from other transport failures",
        "okou_resource_failures",
        """
        import CCState
        import Foundation
        let typed = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled { return [] } // violation
        }
        let qualified = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as Foundation.URLError // violation
            where Foundation.URLError.Code.cancelled == failure.code { return nil }
        }
        let conditional = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError { // violation
            if failure.code == URLError.cancelled { return [] }
            throw failure
          }
        }
        let cast = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if (error as? Foundation.URLError)?.code == .cancelled { return [:] }
            throw error
          }
        }
        let normalized = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled {
            try? await allocated.close()
            throw CancellationError()
          }
        }
    """,
    ),
    (
        "negative conditions and guard continuation retain cancellation polarity",
        "okou_resource_failures",
        """
        import CCState
        let otherwise = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if !Task.isCancelled { throw error } else { return [] }
          }
        }
        let guardedExit = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            guard Task.isCancelled == false else { return nil }
            throw error
          }
        }
        let guardedRead = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            guard error is CancellationError else { throw error }
            return []
          }
        }
        let urlGuard = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError { // violation
            guard failure.code != .cancelled else { return nil }
            throw failure
          }
        }
    """,
    ),
    (
        "evaluation signals preserve their read cancellation",
        "okou_resource_failures",
        """
        import CCState
        let direct = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if options.signal.isCancelled { return [] }
            throw error
          }
        }
        let aliased = computedTask { get, options in
          let signal = options.signal
          do { return try await service.load() }
          catch { // violation
            if signal.isCancelled && shouldStop { return nil }
            throw error
          }
        }
    """,
    ),
    (
        "noncancelled branches and unrelated business values remain valid",
        "okou_resource_failures",
        """
        import CCState
        let ordinary = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if !Task.isCancelled && canRecover { return cached }
            throw error
          }
        }
        let guardRead = computedTask { get, options in
          do { return try await service.load() }
          catch {
            guard !Task.isCancelled else { throw error }
            return cached
          }
        }
        let noncancelledExit = computedTask { get, options in
          do { return try await service.load() }
          catch {
            guard error is CancellationError else { return cached }
            throw error
          }
        }
        let transport = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .notConnectedToInternet { return [] }
        }
        let domain = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as DomainError where failure.code == .cancelled { return [] }
        }
        let unrelated = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if other.isCancelled { return [] }
            throw error
          }
        }
    """,
    ),
    (
        "compound conditions do not invent a cancelled path",
        "okou_resource_failures",
        """
        import CCState
        let impossible = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if false && Task.isCancelled { return [] }
            if true || Task.isCancelled { throw error } else { return [] }
            throw error
          }
        }
        let unrelatedFailure = computedTask { get, options in
          do { return try await service.load() }
          catch {
            guard !Task.isCancelled, canRecover else { return cached }
            return try await service.retry()
          }
        }
        let knownCancellation = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if !(Task.isCancelled == false) { return [] }
            throw error
          }
        }
    """,
    ),
    (
        "throwing recovery and cleanup retain their error owner",
        "okou_resource_failures",
        """
        import CCState
        import Foundation
        let retry = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled {
            try Task.checkCancellation()
            return try await service.retry()
          }
        }
        let cleanup = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled {
            try? await allocated.close()
            throw failure
          }
        }
        let conditional = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if error is CancellationError { try? await allocated.close(); throw error }
            throw error
          }
        }
    """,
    ),
    (
        "an optional retry still turns cancellation into success",
        "okou_resource_failures",
        """
        import CCState
        let optional = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            if Task.isCancelled { return try? await service.retry() }
            throw error
          }
        }
    """,
    ),
    (
        "an empty URL cancellation handler still drops the failure",
        "okou_resource_failures",
        """
        import CCState
        let value = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled {} // violation
          return []
        }
    """,
    ),
    (
        "native commands and completion-only bridges may end cancellation",
        "okou_resource_failures",
        """
        import CCState
        let action = asyncCommand { context in
          do { try await service.save() }
          catch {
            if error is CancellationError || Task.isCancelled { return }
            throw error
          }
        }
        func makeCompletion() -> Computed<Task<Void, Never>> {
          Computed { get in
            Task {
              do { try await service.finish() }
              catch {
                if Task.isCancelled { return }
                owner.report(error)
              }
            }
          }
        }
    """,
    ),
    (
        "deferred helpers and shadowed error names are separate scopes",
        "okou_resource_failures",
        """
        import CCState
        let deferred = computedTask { get, options in
          do { return try await service.load() }
          catch let failure as URLError where failure.code == .cancelled {
            let callback = { if Task.isCancelled { return [] }; return cached }
            func fixture() -> [Int] { return [] }
            var specimen: [Int] { return [] }
            throw failure
          }
        }
        let shadowed = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if useCached {
              let error = cachedFailure
              if error is CancellationError { return [] }
            }
            throw error
          }
        }
    """,
    ),
    (
        "nested handlers own their returns without attributing them to another catch",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch {
            do { try await service.recover() }
            catch { // violation
              if error is CancellationError { return [] }
              throw error
            }
            throw error
          }
        }
    """,
    ),
    (
        "optional bindings and local signal names cannot impersonate the read owner",
        "okou_resource_failures",
        """
        import CCState
        let cached = computedTask { get, options in
          do { return try await service.load() }
          catch {
            if let error = cachedFailure {
              if error is CancellationError { return [] }
            }
            throw error
          }
        }
        let aliased = computedTask { get, options in
          let signal = options.signal
          do { return try await service.load() }
          catch {
            let signal = unrelatedTask
            if signal.isCancelled { return [] }
            throw error
          }
        }
        let optional = computedTask { get, options in
          let signal = options.signal
          do { return try await service.load() }
          catch {
            if let signal = optionalTask, signal.isCancelled { return [] }
            throw error
          }
        }
    """,
    ),
    (
        "only known read execution inherits resource cancellation",
        "okou_resource_failures",
        """
        import CCState
        let read = Computed { get, options in
          let action = {
            do { return try owner.optionalValue() }
            catch {
              if Task.isCancelled { return [] }
              throw error
            }
          }
          func nativeOperation() throws -> [Int] {
            do { return try owner.optionalValue() }
            catch {
              if Task.isCancelled { return [] }
              throw error
            }
          }
          return Task.immediate {
            do { return try await service.load() }
            catch { // violation
              if Task.isCancelled { return [] }
              throw error
            }
          }
        }
    """,
    ),
    (
        "Task captures preserve the identity of the evaluation signal",
        "okou_resource_failures",
        """
        import CCState
        let unrelated = Computed { get, options in
          let signal = options.signal
          return Task { [signal = otherTask] in
            do { return try await service.load() }
            catch {
              if signal.isCancelled { return [] }
              throw error
            }
          }
        }
        let captured = Computed { get, options in
          let signal = options.signal
          return Task { [signal] in
            do { return try await service.load() }
            catch { // violation
              if signal.isCancelled { return [] }
              throw error
            }
          }
        }
        let snapshot = Computed { get, options in
          let signal = options.signal
          return Task { [signal = signal] in
            do { return try await service.load() }
            catch { // violation
              if signal.isCancelled { return [] }
              throw error
            }
          }
        }
    """,
    ),
    (
        "case bindings shadow an error while case names do not",
        "okou_resource_failures",
        """
        import CCState
        let unrelated = computedTask { get, options in
          do { return try await service.load() }
          catch {
            switch cachedResult {
            case .failure(let error):
              if error is CancellationError { return [] }
            case let .cached(error):
              if error is CancellationError { return [] }
            default: break
            }
            if case .failure(let error) = cachedResult {
              if error is CancellationError { return [] }
            }
            throw error
          }
        }
        let original = computedTask { get, options in
          do { return try await service.load() }
          catch { // violation
            switch status {
            case .error:
              if error is CancellationError { return [] }
            default: break
            }
            throw error
          }
        }
    """,
    ),
]
