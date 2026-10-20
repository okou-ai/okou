import ChatData
import ChatDomain
import Foundation
import Observation

/// One composer owns device persistence, canonical draft hydration and a serialized save loop.
@MainActor @Observable
final class ComposerDraftStore {
  struct LocalRecord: Codable {
    var value: ComposerDraft
    var files: [AttachmentDraftStore.SavedItem]
    var baseline: ComposerDraft?
    var dirty: Bool
    var cleared: Bool
  }

  var text: String {
    get { document.text }
    set {
      guard !closed, newValue != document.text else { return }
      document.replaceText(newValue)
      changed()
    }
  }
  private(set) var document = ChatDraftDocument()
  let attachments: AttachmentDraftStore
  var error: String? { localError ?? syncError }
  private var localReadFailed = false
  private var localError: String?
  private var syncError: String?
  private(set) var conflictingRemote: ComposerDraft?
  var contextLabels: [String] { document.contextLabels }
  var canSend: Bool {
    let ids = Set(
      document.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    return document.isSupported && !localReadFailed && conflictingRemote == nil
      && ids.isSubset(of: Set(attachments.uploaded.map(\.id)))
  }
  var hasContent: Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || document.parts.contains { $0["type"]?.string != "text" }
      || attachments.hasAttachments
  }
  var isDurable: Bool {
    storage != nil && localError == nil && attachments.importingCount == 0
      && !attachments.items.contains { if case .uploading = $0.state { true } else { false } }
  }
  func requestSync() {
    guard !closed, !Task.isCancelled, syncTask == nil else { return }
    Task { [weak self] in await self?.synchronize() }
  }
  private let target: ChatDraftTarget
  private let repository: ChatDraftRepository?
  private let storage: ChatDraftStorage?
  private let didFail: @MainActor (Error) -> Void
  private var metadata: [ComposerDraft.DraftAttachment] = []
  private var baseline: ComposerDraft?
  private var dirty = false
  private var cleared = false
  private var revision = 0
  private var applying = false
  private var closed = false
  private var debounceTask: Task<Void, Never>?
  private var syncTask: Task<Void, Never>?

  init(
    target: ChatDraftTarget, commands: ChatCommands, repository: ChatDraftRepository? = nil,
    storage: ChatDraftStorage? = nil, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.target = target
    self.repository = repository
    self.storage = storage
    self.didFail = didFail
    attachments = AttachmentDraftStore(commands: commands, didFail: didFail)
    do {
      if let saved = try storage?.load(target.key, as: LocalRecord.self) {
        document = saved.value.draftUserMessage ?? ChatDraftDocument()
        metadata = saved.value.draftAttachments ?? []
        baseline = saved.baseline
        dirty = saved.dirty
        cleared = saved.cleared
        attachments.restore(saved.files)
      }
    } catch {
      localReadFailed = true
      localError =
        "Cannot restore the device draft. Clear it explicitly to start again. "
        + error.localizedDescription
      didFail(error)
    }
    attachments.didChange = { [weak self] in self?.changed() }
    attachments.didRemove = { [weak self] fileID in
      guard let self, let fileID else { return }
      document.parts.removeAll { $0["type"]?.string == "file" && $0["fileId"]?.string == fileID }
      metadata.removeAll { $0.id == fileID }
      changed()
    }
  }

  var value: ComposerDraft {
    var result = document
    let files = attachments.savedItems.compactMap(\.uploaded)
    let existing = Set(
      result.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    for file in files where !existing.contains(file.id) {
      result.parts.append(
        .object([
          "type": .string("file"), "fileId": .string(file.id),
          "filenameSnapshot": .string(file.filename), "contentType": .string(file.contentType),
        ]))
    }
    var persisted = metadata
    for file in files {
      guard let url = file.url else { continue }
      persisted.removeAll { $0.id == file.id }
      persisted.append(ComposerDraft.DraftAttachment(attachment: file, url: url))
    }
    return ComposerDraft(
      document: result.parts.isEmpty ? nil : result,
      attachments: persisted.isEmpty ? nil : persisted)
  }

  private func changed() {
    guard !closed, !applying else { return }
    revision += 1
    dirty = true
    if hasContent { cleared = false }
    persist()
    debounceTask?.cancel()
    debounceTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
      await self?.synchronize()
    }
  }

  private func persist() {
    guard !closed, !localReadFailed else { return }
    do {
      try storage?.save(
        LocalRecord(
          value: value, files: attachments.savedItems,
          baseline: baseline, dirty: dirty, cleared: cleared), key: target.key)
      localError = nil
    } catch {
      localError = "Cannot save this draft on the device. " + error.localizedDescription
      didFail(error)
    }
  }

  func synchronize() async {
    guard !closed, !Task.isCancelled, !localReadFailed, let repository else { return }
    if let syncTask {
      await syncTask.value
      return
    }
    let task = Task { [weak self] in
      guard let self else { return }
      defer { syncTask = nil }
      repeat {
        let startedRevision = revision
        do {
          let remote = try await repository.load(target)
          try Task.checkCancellation()
          guard !closed else { return }
          if dirty {
            // The API has no conditional writes. Refuse a known changed snapshot on reconnect;
            // overlapping writes after this read still follow the API's last-writer semantics.
            let changedElsewhere = baseline.map { $0 != remote } ?? (remote != ComposerDraft())
            if changedElsewhere && remote != value
              && (baseline != nil || startedRevision == revision)
            {
              conflictingRemote = remote
              syncError = "This draft changed on another device. Choose which draft to keep."
              persist()
              return
            }
          } else if startedRevision == revision {
            if cleared && remote != value {
              conflictingRemote = remote
              syncError =
                "A draft appeared after this device cleared it. Choose which draft to keep."
              persist()
              return
            }
            // Providers can still be preparing their file. Preserve that action
            // through the same conflict path as interrupted local attachments.
            if revision == 0 && attachments.importingCount == 0
              && !attachments.savedItems.contains(where: { $0.uploaded == nil })
            {
              if remote != value { apply(remote) }
            } else if remote != baseline && remote != value {
              conflictingRemote = remote
              syncError = "This draft changed on another device. Choose which draft to keep."
              persist()
              return
            }
          }
          baseline = remote
          guard document.isSupported else {
            syncError = "This draft contains content this app cannot edit. Open it on the web."
            persist()
            return
          }
          guard dirty else {
            syncError = nil
            persist()
            return
          }
          let sentRevision = revision
          let sent = value
          try await repository.save(sent, to: target)
          try Task.checkCancellation()
          guard !closed else { return }
          baseline = sent
          if sentRevision == revision { dirty = false }
          conflictingRemote = nil
          syncError = nil
          persist()
        } catch is CancellationError { return } catch {
          guard !closed, !Task.isCancelled else { return }
          report(error)
          persist()
          return
        }
      } while dirty && !closed && !Task.isCancelled
    }
    syncTask = task
    await task.value
  }

  private func apply(_ remote: ComposerDraft) {
    applying = true
    document = remote.draftUserMessage ?? ChatDraftDocument()
    metadata = remote.draftAttachments ?? []
    cleared = false
    attachments.restoreRemote(remote)
    applying = false
  }

  func useRemote() {
    guard let remote = conflictingRemote else { return }
    revision += 1
    apply(remote)
    baseline = remote
    dirty = false
    conflictingRemote = nil
    syncError = nil
    persist()
  }

  func keepLocal() {
    guard let remote = conflictingRemote else { return }
    baseline = remote
    conflictingRemote = nil
    syncError = nil
    changed()
  }

  func clear() {
    guard !closed else { return }
    localReadFailed = false
    cleared = true
    applying = true
    document = ChatDraftDocument()
    metadata = []
    attachments.reset()
    applying = false
    if let conflictingRemote { baseline = conflictingRemote }
    conflictingRemote = nil
    changed()
  }

  func move(to destination: ComposerDraftStore) {
    destination.applying = true
    destination.document = value.draftUserMessage ?? ChatDraftDocument()
    destination.metadata = value.draftAttachments ?? []
    attachments.moveReadyFiles(to: destination.attachments)
    destination.applying = false
    destination.changed()
    clear()
  }

  func close() {
    guard !closed else { return }
    persist()
    closed = true
    debounceTask?.cancel()
    syncTask?.cancel()
    attachments.close(preserveFiles: storage != nil)
  }

  private func report(_ failure: Error) {
    syncError = "Draft sync unavailable. " + failure.localizedDescription
    didFail(failure)
  }
}
