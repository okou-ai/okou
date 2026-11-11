"""Keyed Task replacement contracts at the SwiftLint CLI boundary."""

TASK_DICTIONARY_CASES = [
    (
        "dictionary replacement preserves the old task at the same key",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          func unsafe(_ id: String) {
            tasks[id] = Task { await service.refresh() } // violation
          }
          func local(_ id: String) {
            let work = Task { await service.refresh() } // violation
            self.tasks[id] = work
          }
          func cancel(_ id: String) {
            tasks[id]?.cancel()
            tasks[id] = Task { await service.refresh() }
          }
          func wrongKey(_ id: String, other: String) {
            tasks[other]?.cancel()
            tasks[id] = Task { await service.refresh() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
        final class Qualified {
          private var tasks: Swift.Dictionary<String, Swift.Task<Void, Never>> = [:]
          func start(_ id: String) {
            tasks[id] = Task { await service.refresh() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "keyed absence and reuse guards fence the continuing path",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: Dictionary<String, Task<Void, Never>> = [:]
          func start(_ id: String) {
            guard enabled, tasks[id] == nil else { return }
            tasks[id] = Task { await service.refresh() }
          }
          func reuse(_ id: String) async {
            if let existing = self.tasks[id] { await existing.value; return }
            tasks[id] = Task { await service.refresh() }
          }
          func conditional(_ id: String) {
            if tasks[id] == nil { self.tasks[id] = Task { await service.refresh() } }
          }
          func unrelated(_ id: String, other: String) {
            guard tasks[other] == nil else { return }
            tasks[id] = Task { await service.refresh() } // violation
          }
          func flag(_ id: String) {
            guard !isLoading else { return }
            tasks[id] = Task { await service.refresh() } // violation
          }
          func partial(_ id: String) {
            if enabled { tasks[id]?.cancel() }
            tasks[id] = Task { await service.refresh() } // violation
          }
          func close() { tasks.values.forEach { $0.cancel() } }
        }
    """,
    ),
    (
        "removed keyed originals need cancellation or completion",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Error>] = [:]
          func cancel(_ id: String) {
            tasks.removeValue(forKey: id)?.cancel()
            tasks[id] = Task { try await service.refresh() }
          }
          func complete(_ id: String) async {
            _ = await tasks[id]?.result
            tasks[id] = Task { try await service.refresh() }
          }
          func snapshot(_ id: String) async {
            let old = tasks.removeValue(forKey: id)
            _ = await old?.result
            tasks[id] = Task { try await service.refresh() }
          }
          func lost(_ id: String) {
            tasks.removeValue(forKey: id)
            tasks[id] = Task { try await service.refresh() } // violation
          }
          func cleared(_ id: String) {
            tasks[id] = nil
            tasks[id] = Task { try await service.refresh() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "immutable key aliases and shadowing retain their identities",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          func alias(_ id: String) {
            let key = id
            self.tasks[key]?.cancel()
            tasks[id] = Task { await service.refresh() }
          }
          func literal() {
            let key = "refresh"
            tasks["refresh"]?.cancel()
            tasks[key] = Task { await service.refresh() }
          }
          func member(_ item: Item) {
            let key = item.id
            tasks[key]?.cancel()
            tasks[item.id] = Task { await service.refresh() }
          }
          func optional(_ raw: String?) {
            guard let id = raw else { return }
            guard tasks[id] == nil else { return }
            tasks[id] = Task { await service.refresh() }
          }
          func optionalShadow(_ id: String, other: String?) {
            let key = id
            if let id = other { tasks[id]?.cancel() }
            else { tasks[key]?.cancel() }
            tasks[key] = Task { await service.refresh() } // violation
          }
          func localDictionary(_ id: String) {
            let tasks = unrelated
            tasks[id]?.cancel()
            self.tasks[id] = Task { await service.refresh() } // violation
          }
          func shadow(_ id: String, other: String) {
            if enabled { let id = other; tasks[id]?.cancel() }
            tasks[id] = Task { await service.refresh() } // violation
          }
          func mutable(_ id: String, other: String) {
            var key = id
            tasks[key]?.cancel()
            key = other
            tasks[key] = Task { await service.refresh() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "fresh UUID keys add independent owned tasks",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [UUID: Task<Void, Never>] = [:]
          private var strings: [String: Task<Void, Never>] = [:]
          private let permanent = UUID()
          func insert() {
            let id = UUID()
            let key = id
            tasks[key] = Task { await service.refresh() }
          }
          func insertString() {
            let id = Foundation.UUID().uuidString.lowercased()
            strings[id] = Task { await service.refresh() }
          }
          func stringForms() {
            let upper = UUID().uuidString
            let lower = upper.lowercased()
            strings[upper] = Task { await service.refresh() }
            strings[lower] = Task { await service.refresh() }
          }
          func independent() {
            let first = UUID()
            let second = UUID()
            tasks[first] = Task { await service.refresh() }
            tasks[second] = Task { await service.refresh() }
          }
          func aliasesRetainTheOriginal() {
            let first = UUID()
            let second = UUID()
            let work = Task { await service.refresh() }
            tasks[first] = work
            tasks[second] = work
            tasks[first] = nil
          }
          func repeated() {
            for item in items {
              let id = UUID()
              tasks[id] = Task { await service.refresh(item) }
            }
          }
          func overwriteFresh() {
            let id = UUID()
            tasks[id] = Task { await service.refresh() } // violation
            tasks[id] = Task { await service.refresh() }
          }
          func reusedProperty() {
            tasks[permanent] = Task { await service.refresh() } // violation
          }
          func close() {
            for task in tasks.values { task.cancel() }
            for task in strings.values { task.cancel() }
          }
        }
    """,
    ),
    (
        "keyed original completion survives replacement without cancellation",
        "okou_task_lifecycle",
        """
        final class Queue {
          private var tasks: [String: Task<Void, Never>] = [:]
          func append(_ id: String) {
            let old = tasks[id]
            tasks[id] = Task { await old?.value; await storage.write() }
          }
          func close() -> Task<Void, Never> {
            let pending = Array(tasks.values)
            tasks.removeAll()
            return Task { for task in pending { await task.value } }
          }
        }
        final class CancelWrapper {
          private var tasks: [String: Task<Void, Never>] = [:]
          func append(_ id: String) {
            let old = tasks[id]
            tasks[id] = Task { await old?.value; await storage.write() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "keyed originals transfer to an independently drained owner collection",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          private var retiring: [Task<Void, Never>] = []
          func start(_ id: String) {
            if let old = tasks.removeValue(forKey: id) { retiring.append(old) }
            tasks[id] = Task { await service.refresh() }
          }
          func close() async {
            for task in retiring { await task.value }
            for task in tasks.values { await task.value }
          }
        }
    """,
    ),
    (
        "same owner helpers cancel the requested key rather than another key",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          func start(_ id: String) {
            cancel(id)
            tasks[id] = Task { await service.refresh() }
          }
          func wrong(_ id: String, other: String) {
            cancel(other)
            tasks[id] = Task { await service.refresh() } // violation
          }
          func storeThroughHelper(_ id: String) {
            cancel(id)
            let task = Task { await service.refresh() }
            retain(task, key: id)
          }
          private func retain(_ task: Task<Void, Never>, key: String) { tasks[key] = task }
          private func cancel(_ key: String) { tasks.removeValue(forKey: key)?.cancel() }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "each loop iteration preserves an occupied dictionary slot",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          func unsafe() {
            tasks["refresh"]?.cancel()
            for item in items {
              tasks["refresh"] = Task { await service.refresh(item) } // violation
            }
          }
          func cancelEach() {
            for item in items {
              tasks["refresh"]?.cancel()
              tasks["refresh"] = Task { await service.refresh(item) }
            }
          }
          func guardEach() {
            for item in items {
              guard tasks[item.id] == nil else { continue }
              tasks[item.id] = Task { await service.refresh(item) }
            }
          }
          func completeEach() async {
            tasks["refresh"]?.cancel()
            for item in items {
              tasks["refresh"] = Task { await service.refresh(item) }
              await tasks["refresh"]?.value
            }
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "whole collection snapshots preserve every original across a reset",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [String: Task<Void, Never>] = [:]
          func reset(_ id: String) {
            let old = tasks
            tasks.removeAll()
            for task in old.values { task.cancel() }
            tasks[id] = Task { await service.refresh() }
          }
          func drop(_ id: String) {
            tasks.removeAll()
            tasks[id] = Task { await service.refresh() } // violation
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
    (
        "each continuing branch keeps an original under a keyed cleanup owner",
        "okou_task_lifecycle",
        """
        final class Owner {
          private var tasks: [UUID: Task<Void, Never>] = [:]
          func branches() {
            let first = UUID()
            let second = UUID()
            let work = Task { await service.refresh() }
            if enabled { tasks[first] = work }
            else { tasks[second] = work }
          }
          func lostBranch() {
            let id = UUID()
            let work = Task { await service.refresh() } // violation
            if enabled { tasks[id] = work }
          }
          func dropEveryAlias() {
            let first = UUID()
            let second = UUID()
            let work = Task { await service.refresh() } // violation
            tasks[first] = work
            tasks[second] = work
            tasks[first] = nil
            tasks[second] = nil
          }
          func close() { for task in tasks.values { task.cancel() } }
        }
    """,
    ),
]
