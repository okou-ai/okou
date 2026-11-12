"""Explicitly discarded Tasks must keep an observable error owner."""

THROWING_TASK_CASES = [
    (
        "discarded native Task constructors cannot lose escaping errors",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task { try await service.load() } // violation
          _ = Task.immediate { try await service.load() } // violation
          _ = Task.detached(priority: .utility) { try await service.load() } // violation
          _ = _Concurrency.Task { throw Failure.offline } // violation
          _ = Task<Void, any Error>.init(operation: { try await service.load() }) // violation
        }
    """,
    ),
    (
        "wildcard bindings and grouped Task expressions still discard errors",
        "okou_discarded_throwing_task",
        """
        func start() {
          let _ = Task { try await service.load() } // violation
          let _: Task<Void, Error> = Task { throw Failure.offline } // violation
          _ = (Task { try await service.load() }) // violation
        }
    """,
    ),
    (
        "partial error handlers leave a throwing Task result",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task { // violation
            do { try await service.load() }
            catch is OfflineError { owner.offline() }
          }
          _ = Task { // violation
            do { try await service.load() }
            catch where shouldIgnore { owner.ignore(error) }
          }
          _ = Task { // violation
            do { try await service.load() }
            catch let failure where failure is CancellationError { owner.cancel() }
          }
        }
    """,
    ),
    (
        "errors in any catch handler remain part of the Task result",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task { // violation
            do { try await service.load() }
            catch is OfflineError { throw Failure.retryRequired }
            catch { owner.report(error) }
          }
          _ = Task { // violation
            do { try await service.load() }
            catch { try await service.recover() }
          }
          _ = Task { // violation
            try await withScope { try await service.load() }
          }
        }
    """,
    ),
    (
        "a catch outside the Task cannot receive its errors",
        "okou_discarded_throwing_task",
        """
        func start() {
          do {
            try owner.prepare()
            _ = Task { try await service.load() } // violation
          } catch { owner.report(error) }
        }
    """,
    ),
    (
        "complete internal handlers preserve legitimate background work",
        "okou_discarded_throwing_task",
        """
        import Foundation
        func start() {
          _ = Task { await owner.refresh() }
          _ = Task {
            do { try await service.load() }
            catch { owner.report(error) }
          }
          _ = Task {
            do { try await service.load() }
            catch let failure { owner.report(failure) }
          }
          _ = Task {
            do { try await service.load() }
            catch _ { owner.unavailable() }
          }
          _ = Task {
            do { try await service.load() }
            catch let failure as Foundation.NSError { owner.report(failure) }
          }
          _ = Task {
            do { try await service.load() }
            catch is any Swift.Error { owner.unavailable() }
          }
        }
    """,
    ),
    (
        "nested callbacks and local definitions own their throwing bodies",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task {
            let later = { try service.loadSynchronously() }
            func loadLater() throws { throw Failure.offline }
            struct Fixture {
              var value: Int {
                get throws { try service.loadSynchronously() }
              }
            }
            let captured = Result { try service.loadSynchronously() }
            let explicit = Result(catching: { try service.loadSynchronously() })
            owner.install(later, captured, explicit)
          }
        }
    """,
    ),
    (
        "retaining returning transferring and awaiting keep the Task result",
        "okou_discarded_throwing_task",
        """
        func start() async throws {
          let request = Task { try await service.load() }
          try await request.value
          owner.retain(Task { try await service.load() })
          _ = try await Task { try await service.load() }.value
          _ = await Task { try await service.load() }.result
        }
        func makeTask() -> Task<[Int], Error> {
          return Task { try await service.load() }
        }
        func makeImplicitTask() -> Task<[Int], Error> {
          Task { try await service.load() }
        }
    """,
    ),
    (
        "outer handlers and optional tries contain nested failures",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task {
            do {
              do { try await service.load() }
              catch is OfflineError { throw Failure.retryRequired }
              catch { try await service.recover() }
            } catch { owner.report(error) }
          }
          _ = Task {
            let optional = try? transform(try service.loadSynchronously())
            owner.use(optional)
          }
          _ = Task { try? await service.load() }
          _ = Task { try! await service.load() }
        }
    """,
    ),
    (
        "nested discarded Tasks are diagnosed under their own error scope",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = Task {
            _ = Task { try await service.load() } // violation
          }
          _ = Task { // violation
            _ = Task { try await service.load() } // violation
            throw Failure.offline
          }
        }
    """,
    ),
    (
        "indirect factories retain their independent ownership contracts",
        "okou_discarded_throwing_task",
        """
        func start() {
          _ = owner.makeTask { try await service.load() }
          _ = CustomTask { try await service.load() }
        }
    """,
    ),
]
