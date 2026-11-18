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
    (
        "visible fresh throwing Task factories cannot hide discarded errors",
        "okou_discarded_throwing_task",
        """
        func makeRead() -> Task<[String], Error> {
          Task { try await service.load() }
        }
        func makeExplicitRead() -> _Concurrency.Task<[String], any Error> {
          return (Task.detached { try await service.load() })
        }
        func makeRead(for id: String) -> Task<[String], Error> {
          Task.immediate(operation: { try await service.load(id) })
        }
        func start() {
          _ = makeRead() // violation
          let _ = makeExplicitRead() // violation
          let _: Task<[String], Error> = makeRead(for: "one") // violation
          _ = (makeRead()) // violation
          func makeLocalRead() -> Task<[String], Error> {
            Task { throw Failure.offline }
          }
          _ = makeLocalRead() // violation
        }
    """,
    ),
    (
        "same owner and visible static factories preserve the error obligation",
        "okou_discarded_throwing_task",
        """
        final class Reader {
          func makeRead() -> Task<[String], Error> {
            Task { try await service.load() }
          }
          func start() {
            _ = makeRead() // violation
            _ = self.makeRead() // violation
          }
        }
        struct Reads {
          static func makeRead() -> Task<[String], Error> {
            Task { try await service.load() }
          }
          static func start() {
            _ = Self.makeRead() // violation
          }
        }
        func start() {
          _ = Reads.makeRead() // violation
        }
    """,
    ),
    (
        "every visible return must prove fresh throwing work",
        "okou_discarded_throwing_task",
        """
        func makeRead(_ cache: Bool) -> Task<[String], Error> {
          if cache { return Task { try await service.cached() } }
          return Task { try await service.load() }
        }
        func makeMixedRead() -> Task<[String], Error> {
          if refresh { return Task { try await service.load() } }
          return sharedRead
        }
        func start() {
          _ = makeRead(false) // violation
          _ = makeMixedRead()
        }
    """,
    ),
    (
        "borrowed forwarded and internally handled Tasks retain their contracts",
        "okou_discarded_throwing_task",
        """
        func borrowed() -> Task<[String], Error> { sharedRead }
        func forwarded() -> Task<[String], Error> { unknownFactory() }
        func retained() -> Task<[String], Error> {
          let task = Task { try await service.load() }
          owner.retain(task)
          return task
        }
        func completed() -> Task<Void, Never> { Task {} }
        func handled() -> Task<Void, Never> {
          Task {
            do { try await service.load() }
            catch { owner.report(error) }
          }
        }
        func captured() -> Task<Result<[String], Error>, Never> {
          Task { Result { try service.loadSynchronously() } }
        }
        func start() {
          _ = borrowed()
          _ = forwarded()
          _ = retained()
          _ = completed()
          _ = handled()
          _ = captured()
        }
    """,
    ),
    (
        "factory Task results may be retained awaited returned and transferred",
        "okou_discarded_throwing_task",
        """
        func makeRead() -> Task<[String], Error> {
          Task { try await service.load() }
        }
        func start() async throws {
          let task = makeRead()
          _ = try await task.value
          owner.retain(makeRead())
          _ = try await makeRead().value
          _ = await makeRead().result
        }
        func forward() -> Task<[String], Error> { makeRead() }
    """,
    ),
    (
        "factory lookup respects lexical shadowing and unknown receivers",
        "okou_discarded_throwing_task",
        """
        func makeRead() -> Task<[String], Error> {
          Task { try await service.load() }
        }
        func parameter(makeRead: () -> Task<[String], Error>) {
          _ = makeRead()
        }
        func local() {
          let makeRead = { sharedRead }
          _ = makeRead()
        }
        func nested() {
          func makeRead() -> Task<[String], Error> { sharedRead }
          _ = makeRead()
        }
        func callback() {
          owner.install { makeRead in _ = makeRead() }
        }
        func start(other: Reader) {
          _ = other.makeRead()
          _ = unknownFactory()
        }
        class Reader {
          func makeRead() -> Task<[String], Error> {
            Task { try await service.load() }
          }
          func start() { _ = self.makeRead() }
        }
    """,
    ),
    (
        "overloads require a consistent visible factory contract",
        "okou_discarded_throwing_task",
        """
        func makeRead(_ value: Int) -> Task<[String], Error> {
          Task { try await service.load(value) }
        }
        func makeRead(_ value: String) -> Task<[String], Error> { sharedRead }
        func makeFresh(_ value: Int) -> Task<[String], Error> {
          Task { try await service.load(value) }
        }
        func makeFresh(_ value: String) -> Task<[String], Error> {
          Task { try await service.load(value) }
        }
        func start() {
          _ = makeRead(1)
          _ = makeFresh(1) // violation
        }
    """,
    ),
    (
        "unsupported factory signatures and custom Task types need review",
        "okou_discarded_throwing_task",
        """
        func makeDefault(_ value: Int = 1) -> Task<[String], Error> {
          Task { try await service.load(value) }
        }
        func makeVariadic(_ values: Int...) -> Task<[String], Error> {
          Task { try await service.load(values) }
        }
        func makeCustom() -> CustomTask<[String], Error> {
          CustomTask { try await service.load() }
        }
        func start() {
          _ = makeDefault()
          _ = makeVariadic(1, 2)
          _ = makeCustom()
        }
    """,
    ),
]
