import CCState
import ChatData
import Foundation

/// Confirmed sidebar membership and released local drafts, independent of list invalidations.
/// The membership lives in the workspace session's Store. Sidebar rows and the widget publisher
/// read `threadIDsValue` through CCStateSwiftUI; `threadIDs` serves owner logic and tests.
@MainActor
final class SidebarDraftStore {
  private let confirmedIDs = CCState.State<Set<String>>([])
  let threadIDsValue: Computed<Set<String>>
  var threadIDs: Set<String> {
    do { return try resources.store.get(confirmedIDs) } catch {
      preconditionFailure("Cannot read the sidebar draft membership: \(error)")
    }
  }
  private let resources: WorkspaceResources
  private let lifecycleTasks: LifecycleTasks
  private let didFail: @MainActor (Error) -> Void
  // Only changes made during the current publication need to overlay that response.
  private var releasedDuringRead: [String: Bool] = [:]
  private var readID = UUID()
  private var closed = false
  private var publication: Task<Void, Never>?
  /// The membership read the latest publication confirms.
  private var publishedRead: Task<Set<String>, Error>?

  init(
    resources: WorkspaceResources, lifecycleTasks: LifecycleTasks,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.resources = resources
    self.lifecycleTasks = lifecycleTasks
    self.didFail = didFail
    let confirmedIDs = confirmedIDs
    threadIDsValue = Computed { get in try get(confirmedIDs) }
  }

  /// Starts confirming the cached membership read. The read is reloaded only by `didSave` and by
  /// the workspace's retry, which activates this owner afterwards, so each confirms its own read
  /// instead of subscribing to it.
  func activate() async {
    guard !closed, !Task.isCancelled else { return }
    confirm()
    await publication?.value
  }

  /// Match Web: text-only edits reuse membership; successful add/clear writes invalidate it.
  func didSave(_ draft: ComposerDraft, threadID: String) async {
    guard !closed, !Task.isCancelled else { return }
    do {
      let listed = try await resources.store.get(resources.sidebarDraftThreadIDs).value
      try Task.checkCancellation()
      guard !closed else { return }
      if listed.contains(threadID) != (draft.draftUserMessage != nil) {
        try resources.store.set(resources.reloadSidebarDrafts)
        confirm()
        await publication?.value
      }
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  func noteReleased(_ id: String, hasDraft: Bool) {
    if publication != nil { releasedDuringRead[id] = hasDraft }
    var ids = threadIDs
    if hasDraft { ids.insert(id) } else { ids.remove(id) }
    publish(ids)
  }

  /// This confirmed snapshot combines with resident composers. Request phases remain
  /// exclusively on the original resource Task; local changes overlay an older response.
  /// Each membership read is confirmed once, as a subscription would on its invalidation.
  private func confirm() {
    guard !closed else { return }
    let read: Task<Set<String>, Error>
    do { read = try resources.store.get(resources.sidebarDraftThreadIDs) } catch {
      publication?.cancel()
      didFail(error)
      return
    }
    guard read != publishedRead else { return }
    publishedRead = read
    publication?.cancel()
    let id = UUID()
    readID = id
    releasedDuringRead.removeAll()
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if readID == id {
          publication = nil
          releasedDuringRead.removeAll()
        }
      }
      do {
        var ids = try await read.value
        try Task.checkCancellation()
        guard !closed, readID == id else { return }
        for (threadID, hasDraft) in releasedDuringRead {
          if hasDraft { ids.insert(threadID) } else { ids.remove(threadID) }
        }
        publish(ids)
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled, readID == id else { return }
        didFail(error)
      }
    }
    lifecycleTasks.track(task)
    publication = task
  }

  private func publish(_ ids: Set<String>) {
    guard ids != threadIDs else { return }
    do { try resources.store.set(confirmedIDs, ids) } catch {
      preconditionFailure("Cannot update the sidebar draft membership: \(error)")
    }
  }

  func close() {
    closed = true
    releasedDuringRead.removeAll()
    publication?.cancel()
    publishedRead = nil
  }
}
