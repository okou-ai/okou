"""Async throwing data helpers retain failures outside graph callbacks."""

ASYNC_HELPER_FAILURE_CASES = [
    (
        "async data helpers cannot return successful cancellation data",
        "okou_resource_failures",
        """
        import Foundation
        func readItems() async throws -> [String] {
          do { return try await service.load() }
          catch is CancellationError { return [] } // violation
        }
        func readItem() async throws -> String? {
          do { return try await service.item() }
          catch let cancelled as CancellationError { // violation
            record(cancelled)
            return nil
          }
        }
        func readValues() async throws -> [String: Int] {
          do { return try await service.values() }
          catch let failure where failure is CancellationError { return [:] } // violation
        }
    """,
    ),
    (
        "async data helpers cannot erase unfiltered failures",
        "okou_resource_failures",
        """
        import Foundation
        func readItems() async throws -> [String] {
          do { return try await service.load() }
          catch { return [] } // violation
        }
        func readItem() async throws -> String? {
          do { return try await service.item() }
          catch { return nil } // violation
        }
        func readValues() async throws -> [String: Int] {
          do { return try await service.values() }
          catch { return [:] } // violation
        }
        func readSnapshot() async throws -> [String] {
          do { try await service.refresh() }
          catch {} // violation
          return snapshot
        }
    """,
    ),
    (
        "helper cancellation branches keep their lexical evidence",
        "okou_resource_failures",
        """
        import Foundation
        func readItems() async throws -> [String] {
          do { return try await service.load() }
          catch { // violation
            if Task.isCancelled { return [] }
            throw error
          }
        }
        func readValues() async throws -> [String: Int] {
          do { return try await service.values() }
          catch let error as URLError { // violation
            if error.code == .cancelled { return [:] }
            throw error
          }
        }
        func readItem() async throws -> String? {
          do { return try await service.item() }
          catch { // violation
            let cancelled = error is CancellationError
            switch cancelled {
            case true: return nil
            case false: throw error
            }
          }
        }
        func readWithSignal(_ signal: EvaluationSignal) async throws -> [String] {
          do { return try await service.load() }
          catch { // violation
            if signal.isCancelled { return [] }
            throw error
          }
        }
        func readWithOtherFlag(Task: OperationState) async throws -> [String] {
          do { return try await service.load() }
          catch {
            if Task.isCancelled { return snapshot }
            throw error
          }
        }
    """,
    ),
    (
        "typed domain handling and throwing recovery remain explicit",
        "okou_resource_failures",
        """
        import Foundation
        func optionalItem() async throws -> String? {
          do { return try await service.item() }
          catch is MissingOptionalItem { return nil }
        }
        func readItems() async throws -> [String] {
          do { return try await service.load() }
          catch let original {
            try? await allocated.close()
            throw original
          }
        }
        func readValues() async throws -> [String: Int] {
          do { return try await service.values() }
          catch is CancellationError { throw CancellationError() }
          catch { return try await recovery.load(error) }
        }
        func readRecoveredItem() async throws -> String? {
          do { return try await service.item() }
          catch {
            if error is CancellationError { return try await recovery.load(error) }
            throw error
          }
        }
    """,
    ),
    (
        "completion and explicit result owners retain native contracts",
        "okou_resource_failures",
        """
        import Foundation
        func refresh() async {
          do { try await original.value }
          catch {}
        }
        func close() async throws {
          do { try await operation() }
          catch is CancellationError { return }
        }
        func dismiss() async throws -> Swift.Void {
          do { try await operation() }
          catch is CancellationError {}
        }
        func finish() async throws -> () {
          do { try await operation() }
          catch is CancellationError { return () }
        }
        func outcome() async throws -> Result<[String], Error> {
          do { return .success(try await service.load()) }
          catch { return .failure(error) }
        }
        func makeTask() async throws -> Task<[String], Error> {
          do { try await prepare() }
          catch is CancellationError { return existingTask }
          return existingTask
        }
        func makeCallback() async throws -> @Sendable () -> Void {
          do { try await prepare() }
          catch is CancellationError { return {} }
          return {}
        }
        func cachedItems() async -> [String] {
          do { return try await cache.load() }
          catch { return [] }
        }
        func storedItems() throws -> [String] {
          do { return try cache.load() }
          catch { return [] }
        }
    """,
    ),
    (
        "nested execution cannot inherit a data helper return contract",
        "okou_resource_failures",
        """
        import Foundation
        func readItems() async throws -> [String] {
          defer {
            do { try allocated.close() }
            catch {}
          }
          struct Cleanup {
            init() {
              do { try nativeOperation() }
              catch {}
            }
          }
          let callback = {
            do { try nativeOperation() }
            catch {}
          }
          let task = Task {
            do { try await operation() }
            catch is CancellationError { return }
          }
          func finish() {
            do { try nativeOperation() }
            catch {}
          }
          return try await service.load()
        }
        let native = Computed {
          do { return try nativeOperation() }
          catch { return [] }
        }
    """,
    ),
    (
        "visible aliases retain completion and payload contracts",
        "okou_resource_failures",
        """
        import Foundation
        typealias Completion = Void
        typealias Outcome<Value> = Result<Value, Error>
        typealias Items = [String]
        struct Owner {
          typealias Completion = Void
          typealias Items = [String]
          func finish() async throws -> Self.Completion {
            do { try await operation() }
            catch is CancellationError {}
          }
          func close() async throws -> Owner.Completion {
            do { try await operation() }
            catch is CancellationError {}
          }
          func readItems() async throws -> Self.Items {
            do { return try await service.load() }
            catch is CancellationError { return [] } // violation
          }
        }
        func finish() async throws -> Completion {
          do { try await operation() }
          catch is CancellationError {}
        }
        func outcome() async throws -> Outcome<[String]> {
          do { return .success(try await service.load()) }
          catch let cancelled as CancellationError { return .failure(cancelled) }
          catch { return .failure(error) }
        }
        func readItems() async throws -> Items {
          do { return try await service.load() }
          catch is CancellationError { return [] } // violation
        }
    """,
    ),
    (
        "extracted resource helpers keep the same failure contract",
        "okou_resource_failures",
        """
        import CCState
        func readItems() async throws -> [String] {
          do { return try await service.load() }
          catch is CancellationError { return [] } // violation
        }
        let read = Computed { get, options in
          let task = Task { try await readItems() }
          options.signal.onCancel { task.cancel() }
          return task
        }
    """,
    ),
]
