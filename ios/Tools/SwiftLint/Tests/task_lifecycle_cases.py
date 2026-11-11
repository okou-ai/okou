"""Business Task ownership contracts exercised through the real SwiftLint CLI."""

TASK_LIFECYCLE_CASES = [
    (
        "retained business tasks require explicit teardown without CCState",
        "okou_task_lifecycle",
        """
        import Foundation
        final class Search {
          private var request: Task<Void, Never>?
          func refresh() {
            request?.cancel()
            request = Task { await service.refresh() } // violation
          }
          deinit { request?.cancel() }
        }
        final class WrongHandle {
          var request: Task<Void, Never>?
          var unrelated: Task<Void, Never>?
          func start() {
            request?.cancel()
            let work = Task { await service.refresh() } // violation
            request = work
          }
          func close() { unrelated?.cancel() }
        }
    """,
    ),
    (
        "teardown and replacement preserve the original task",
        "okou_task_lifecycle",
        """
        final class Search {
          private var request: Task<Void, Never>?
          func refresh() {
            cancelRequest()
            let work = Task { await service.refresh() }
            self.request = work
          }
          func close() { cancelRequest() }
          private func cancelRequest() {
            let original = request
            request = nil
            original?.cancel()
          }
        }
        actor Writes {
          private var pending: Task<Void, Error>?
          func write() async {
            _ = await pending?.result
            pending = Task { try await storage.write() }
          }
          func close() async { _ = await pending?.result }
        }
    """,
    ),
    (
        "replacing a live handle without cancellation or completion",
        "okou_task_lifecycle",
        """
        final class Search {
          private var request: Task<Void, Never>?
          func refresh() {
            request = Task { await service.refresh() } // violation
          }
          func close() { request?.cancel() }
        }
        final class Conditional {
          private var request: Task<Void, Never>?
          func refresh() {
            if enabled { request?.cancel() }
            let work = Task { await service.refresh() } // violation
            request = work
          }
          func close() { request?.cancel() }
        }
    """,
    ),
    (
        "a missing handle or completed original permits a new operation",
        "okou_task_lifecycle",
        """
        final class Search {
          private var request: Task<Void, Never>?
          func start() {
            guard request == nil else { return }
            request = Task { await service.refresh() }
          }
          func startIfMissing() {
            if self.request == nil {
              request = Task { await service.refresh() }
            }
          }
          func refresh() async {
            if let request {
              await request.value
              return
            }
            request = Task { await service.refresh() }
          }
          func close() { request?.cancel() }
        }
        final class Snapshot {
          private var request: Task<Void, Never>?
          func refresh() {
            let previous = request
            request = Task { await service.refresh() }
            previous?.cancel()
          }
          func close() {
            if let request { request.cancel() }
          }
        }
    """,
    ),
    (
        "arrays and dictionaries cancel or drain every retained task",
        "okou_task_lifecycle",
        """
        final class Uploads {
          private var requests: [String: Task<Void, Never>] = [:]
          func start(_ id: String) {
            requests[id] = Task { await service.upload(id) }
          }
          func close() {
            let pending = requests
            requests.removeAll()
            for task in pending.values { task.cancel() }
          }
        }
        actor Writes {
          private var pending: [Task<Void, Error>] = []
          func write() { pending.append(Task { try await storage.write() }) }
          func close() async {
            for task in pending { _ = await task.result }
            pending.removeAll()
          }
        }
        final class LostUploads {
          private var requests: [String: Task<Void, Never>] = [:]
          func start(_ id: String) {
            requests[id] = Task { await service.upload(id) } // violation
          }
          func close() { requests.removeAll() }
        }
        final class Partial {
          private var tasks: [Task<Void, Never>] = []
          func start() { tasks.append(Task { await service.refresh() }) } // violation
          func close() {
            for task in tasks where enabled { task.cancel() }
          }
        }
    """,
    ),
    (
        "shadowed handles and deferred closures do not release owned work",
        "okou_task_lifecycle",
        """
        final class Shadow {
          private var request: Task<Void, Never>?
          func start() {
            request?.cancel()
            request = Task { await service.refresh() } // violation
          }
          func close(request: Task<Void, Never>?) { request?.cancel() }
        }
        final class Deferred {
          private var request: Task<Void, Never>?
          func start() {
            request?.cancel()
            request = Task { await service.refresh() } // violation
          }
          func close() { let unused = { request?.cancel() } }
        }
        final class Conditional {
          private var request: Task<Void, Never>?
          func start() {
            request?.cancel()
            request = Task { await service.refresh() } // violation
          }
          func close() {
            guard enabled else { return }
            request?.cancel()
          }
        }
    """,
    ),
    (
        "initializer ownership and idempotent close",
        "okou_task_lifecycle",
        """
        final class Initial {
          private var request: _Concurrency.Task<Void, Never>?
          private var closed = false
          init() { request = Task.detached { await service.refresh() } }
          func close() {
            guard !closed else { return }
            closed = true
            request?.cancel()
            request = nil
          }
        }
        final class Property {
          private let request: Task<Void, Never> = Task { await service.refresh() }
          func close() { request.cancel() }
        }
    """,
    ),
    (
        "shared tasks, evaluation tasks and native view lifetimes keep their own contracts",
        "okou_task_lifecycle",
        """
        import CCState
        final class Borrower {
          let request: Task<Void, Never>
          init(request: Task<Void, Never>) { self.request = request }
        }
        final class Resource {
          private var current: Task<String, Error>?
          lazy var value = Computed { get, options in
            let work = Task { try await service.read() }
            current = work
            options.signal.onCancel { work.cancel() }
            return work
          }
          func close() {}
          func factory(_ signal: EvaluationSignal) -> Task<String, Error> {
            let task = Task { try await service.read() }
            current = task
            signal.onCancel { task.cancel() }
            return task
          }
        }
        final class OrdinaryOperation {
          private var current: Task<Void, Never>?
          func start(signal: EvaluationSignal) {
            current?.cancel()
            current = Task { await service.refresh() } // violation
          }
          func close() {}
        }
        struct Screen: View {
          @State private var request: Task<Void, Never>?
          var body: some View {
            Text("Refresh").task { await service.refresh() }
              .onDisappear { request?.cancel() }
          }
        }
        final class Local {
          func refresh() async {
            let task = Task { await service.refresh() }
            await task.value
          }
        }
    """,
    ),
]

TASK_LIFECYCLE_CASES += [
    (
        "returned drains preserve queued completion without claiming upstream cancellation",
        "okou_task_lifecycle",
        """
        final class Queue {
          private var tail: Task<Void, Never>?
          func append() {
            let previous = tail
            let work = Task { await previous?.value; await storage.write() }
            tail = Task { await work.value }
          }
          func close() -> Task<Void, Never> {
            let pending = tail
            tail = nil
            return Task { await pending?.value }
          }
        }
        final class CancelWrapper {
          private var tail: Task<Void, Never>?
          func append() {
            let previous = tail
            tail = Task { await previous?.value; await storage.write() } // violation
          }
          func close() { tail?.cancel() }
        }
        final class DiscardedDrain {
          private var task: Task<Void, Never>?
          func start() {
            task?.cancel()
            task = Task { await service.refresh() } // violation
          }
          func close() {
            let pending = task
            task = nil
            Task { await pending?.value }
          }
        }
    """,
    ),
    (
        "retired protocol tasks transfer into an owner-held drain collection",
        "okou_task_lifecycle",
        """
        final class Authorization {
          private var current: Task<Void, Never>?
          private var finishing: [String: Task<Void, Never>] = [:]
          func start() {
            retire()
            current = Task { await service.startAndCleanUpLateSession() }
          }
          private func retire() {
            if let current { finishing[id] = current }
            if phase != .starting { current?.cancel() }
            current = nil
          }
          func close() -> Task<Void, Never> {
            let current = current
            let pending = Array(finishing.values)
            finishing.removeAll()
            retire()
            return Task {
              for task in pending { await task.value }
              await current?.value
            }
          }
        }
    """,
    ),
    (
        "drain loops and compound absence guards",
        "okou_task_lifecycle",
        """
        final class Search {
          private var current: Task<Void, Never>?
          func start() {
            guard enabled, current == nil, !closed else { return }
            current = Task { await service.refresh() }
          }
          func close() { current?.cancel() }
        }
        actor Jobs {
          private var tasks: [Task<Void, Never>] = []
          func start() { tasks.append(Task { await service.refresh() }) }
          private func drain() async {
            while !tasks.isEmpty {
              let pending = tasks
              tasks.removeAll()
              for task in pending { await task.value }
            }
          }
          func close() async { await drain() }
        }
        final class ConditionalClose {
          private var task: Task<Void, Never>?
          private var closed = false
          func start() {
            task?.cancel()
            task = Task { await service.refresh() } // violation
          }
          func close() {
            guard !closed, enabled else { return }
            task?.cancel()
          }
        }
    """,
    ),
    (
        "shadowing a cleanup capture never drains the original task",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var task: Task<Void, Never>?
          private var unrelated: Task<Void, Never>?
          func start() {
            task?.cancel()
            task = Task { await service.refresh() } // violation
          }
          func close() -> Task<Void, Never> {
            let pending = task
            task = nil
            return Task { [pending = unrelated] in await pending?.value }
          }
        }
    """,
    ),
]

TASK_LIFECYCLE_CASES += [
    (
        "direct inferred storage and qualified generic task constructors are checked",
        "okou_task_lifecycle",
        """
        final class Inferred {
          private let task = Swift.Task<Void, Never>.detached { await service.refresh() } // violation
          func close() {}
        }
        final class Collection {
          private let tasks = [Task { await service.refresh() }] // violation
          func close() { tasks.forEach { _ in } }
        }
        final class Valid {
          private let task = _Concurrency.Task<Void, Never>.init { await service.refresh() }
          func close() { task.cancel() }
        }
        final class ExplicitOperation {
          private var task: Task<Void, Never>?
          func start() {
            task?.cancel()
            task = Task(operation: { await service.refresh() }) // violation
          }
          func close() {}
        }
        final class Worker {
          private var task: Task<Void, Never>?
          func start() {
            task?.cancel()
            task = Task.detached { service.compute() } // violation
          }
          func close() {}
        }
    """,
    ),
]

TASK_LIFECYCLE_CASES += [
    (
        "acquisition cannot discard the new original before owner teardown",
        "okou_task_lifecycle",
        """
        final class Dropped {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            current = Task { await service.refresh() } // violation
            current = nil
          }
          func close() { current?.cancel() }
        }
        final class Cleared {
          private var tasks: [Task<Void, Never>] = []
          func start() {
            tasks.append(Task { await service.refresh() }) // violation
            tasks.removeAll()
          }
          func close() { for task in tasks { task.cancel() } }
        }
    """,
    ),
]

TASK_LIFECYCLE_CASES += [
    (
        "asynchronous drains capture immutable originals rather than late mutable reads",
        "okou_task_lifecycle",
        """
        final class LateProperty {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            current = Task { await service.refresh() } // violation
          }
          func close() -> Task<Void, Never> {
            let cleanup = Task { await self.current?.value }
            current = nil
            return cleanup
          }
        }
        final class MutableCapture {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            current = Task { await service.refresh() } // violation
          }
          func close() -> Task<Void, Never> {
            var pending = current
            let cleanup = Task { await pending?.value }
            pending = nil
            current = nil
            return cleanup
          }
        }
        final class Captured {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            current = Task { await service.refresh() }
          }
          func close() -> Task<Void, Never> {
            let cleanup = Task { [pending = current] in await pending?.value }
            current = nil
            return cleanup
          }
        }
    """,
    ),
    (
        "repeated acquisition handles every iteration rather than only the entering task",
        "okou_task_lifecycle",
        """
        final class Repeated {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            for id in ids {
              current = Task { await service.refresh(id) } // violation
            }
          }
          func close() { current?.cancel() }
        }
        final class CancelEach {
          private var current: Task<Void, Never>?
          func start() {
            for id in ids {
              current?.cancel()
              current = Task { await service.refresh(id) }
            }
          }
          func close() { current?.cancel() }
        }
        actor CompleteEach {
          private var current: Task<Void, Never>?
          func start() async {
            current?.cancel()
            for id in ids {
              current = Task { await service.refresh(id) }
              await current?.value
            }
          }
          func close() { current?.cancel() }
        }
        final class RepeatedInitializer {
          private var current: Task<Void, Never>?
          init() {
            for id in ids {
              current = Task { await service.refresh(id) } // violation
            }
          }
          func close() { current?.cancel() }
        }
        final class StopAfterFirst {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            current = nil
            while current == nil {
              current = Task { await service.refresh() }
            }
          }
          func close() { current?.cancel() }
        }
        final class SingleIteration {
          private var current: Task<Void, Never>?
          func start() {
            current?.cancel()
            for id in ids {
              current = Task { await service.refresh(id) }
              break
            }
          }
          func close() { current?.cancel() }
        }
    """,
    ),
]
