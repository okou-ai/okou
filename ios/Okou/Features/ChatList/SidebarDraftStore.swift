import CCState
import ChatData
import Foundation
import OSLog
import Observation

/// Confirmed sidebar membership and released local drafts, independent of list invalidations.
@MainActor @Observable
final class SidebarDraftStore {
  private(set) var threadIDs: Set<String> = []
  private let resources: WorkspaceResources
  private let lifecycleTasks: LifecycleTasks
  private let didFail: @MainActor (Error) -> Void
  // Only changes made during the current publication need to overlay that response.
  private var releasedDuringRead: [String: Bool] = [:]
  private var readID = UUID()
  private var closed = false
  @ObservationIgnored private var subscription: Subscription?
  @ObservationIgnored private var publication: Task<Void, Never>?

  init(
    resources: WorkspaceResources, lifecycleTasks: LifecycleTasks,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.resources = resources
    self.lifecycleTasks = lifecycleTasks
    self.didFail = didFail
  }

  func activate() async {
    guard !closed, !Task.isCancelled else { return }
    do {
      if subscription == nil {
        subscription = try resources.store.watch(resources.sidebarDraftThreadIDs) {
          [weak self] in self?.confirm()
        }
        confirm()
      }
      await publication?.value
    } catch { didFail(error) }
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
        await publication?.value
      }
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  func noteReleased(_ id: String, hasDraft: Bool) {
    if publication != nil { releasedDuringRead[id] = hasDraft }
    if hasDraft { threadIDs.insert(id) } else { threadIDs.remove(id) }
  }

  /// This confirmed snapshot combines with resident composers. Request phases remain
  /// exclusively on the original resource Task; local changes overlay an older response.
  private func confirm() {
    guard !closed else { return }
    publication?.cancel()
    let id = UUID()
    readID = id
    releasedDuringRead.removeAll()
    do {
      let read = try resources.store.get(resources.sidebarDraftThreadIDs)
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
          threadIDs = ids
        } catch is CancellationError {
        } catch {
          guard !closed, !Task.isCancelled, readID == id else { return }
          didFail(error)
        }
      }
      lifecycleTasks.track(task)
      publication = task
    } catch { didFail(error) }
  }

  func close() {
    closed = true
    releasedDuringRead.removeAll()
    publication?.cancel()
    do { try subscription?.cancel() } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatDrafts")
        .error("Cannot close draft observation: \(error.localizedDescription, privacy: .public)")
    }
    subscription = nil
  }
}
