import CCState
import ChatData
import ChatDomain
import Foundation
import SwiftUI

/// One composer owns device persistence, canonical draft hydration and a serialized save loop.
/// Like the web composer, its draft, upload and voice state live in one CCState graph: SwiftUI
/// reads `presentation` through CCStateSwiftUI, and actions use the synchronous accessors.
@MainActor
final class ComposerDraftStore {
  private let lifecycleTasks: LifecycleTasks
  struct LocalRecord: Codable {
    var value: ComposerDraft
    var files: [AttachmentDraftStore.SavedItem]
    var baseline: ComposerDraft?
    var dirty: Bool
    var cleared: Bool
    var consumedVoiceID: UUID?
  }

  var text: String {
    get { document.text }
    set {
      guard !closed, newValue != document.text else { return }
      document.replaceText(newValue)
      changed()
    }
  }
  typealias EditorBlock = ComposerEditorBlock

  struct EditorFocusRequest: Equatable {
    let id = UUID()
    let blockID: UUID
  }

  /// The workspace session's Store, which keeps this composer's graph values.
  let store: CCState.Store
  let signals: ComposerDraftSignals
  var presentation: Computed<ComposerDraftPresentation> { signals.presentation }
  var unsentContent: Computed<Bool> { signals.unsentContent }
  var focusRequest: EditorFocusRequest? { signals.snapshot.focusRequest }
  var editorGeneration: UUID { signals.snapshot.generation }
  var editorBlocks: [EditorBlock] { signals.editorBlocks }

  private func resetEditors() {
    editor.dismissMentions()
    editor.workflows.dismiss()
    signals.resetEditors()
  }

  func requestEditorFocus(_ id: UUID) { signals.requestFocus(id) }

  func consumeFocusRequest(_ request: EditorFocusRequest) { signals.consumeFocus(request) }

  @discardableResult func addFeedback(_ selection: ChatFeedbackSelection) -> UUID? {
    guard let id = signals.addFeedback(selection) else { return nil }
    changed()
    return id
  }

  func editBlock(_ id: UUID, text: String) {
    guard !closed, let block = editorBlocks.first(where: { $0.id == id }),
      block.content.text != text
    else { return }
    var content = block.content
    content.replaceText(text)
    editBlock(id, document: content)
  }

  func editBlock(_ id: UUID, document content: ChatDraftDocument) {
    if signals.editBlock(id, document: content) { changed() }
  }

  func removeFeedback(_ id: UUID) {
    guard !closed, editorBlocks.contains(where: { $0.id == id }) else { return }
    let focusedID = editor.prepareForFeedbackRemoval(id)
    if signals.removeFeedback(id, focusedID: focusedID, keepingNote: preservesFeedbackNotes) {
      changed()
    }
  }

  private(set) var document: ChatDraftDocument {
    get { signals.snapshot.document }
    set { signals.replaceDocument(newValue) }
  }
  let attachments: AttachmentDraftStore
  let editor: ComposerEditor
  let voice: ComposerVoiceInputStore?
  private var consumedVoiceID: UUID?
  var canEditVoice: Bool { canEditDocument }
  private var canEditDocument: Bool {
    ComposerDraftRules.canEditDocument(signals.snapshot, signals.statusSnapshot)
  }

  func appendVoiceClip(_ fileID: String, recordingID: UUID) {
    guard consumedVoiceID != recordingID else { return }
    consumedVoiceID = recordingID
    document.parts.append(
      .object([
        "type": .string("voice"), "clips": .array([.object(["fileId": .string(fileID)])])
      ]))
    resetEditors()
    changed()
  }

  func insertVoiceText(_ text: String, id: UUID, at target: ComposerEditor.VoiceInsertion) -> Bool {
    guard canEditVoice else { return false }
    if consumedVoiceID == id { return true }
    let previous = consumedVoiceID
    consumedVoiceID = id
    guard editor.insertVoiceText(text, at: target) else {
      consumedVoiceID = previous
      return false
    }
    return true
  }
  var error: String? { localError ?? syncError }
  var hasLocalFailure: Bool { localError != nil }
  var canRetryLocalSave: Bool { !localReadFailed }
  func retryLocalSave() { persist() }
  private var localReadFailed: Bool {
    get { signals.statusSnapshot.localReadFailed }
    set { signals.updateStatus { $0.localReadFailed = newValue } }
  }
  private var localError: String? {
    get { signals.statusSnapshot.localError }
    set { signals.updateStatus { $0.localError = newValue } }
  }
  private var syncError: String? {
    get { signals.statusSnapshot.syncError }
    set { signals.updateStatus { $0.syncError = newValue } }
  }
  private(set) var syncWarning: String? {
    get { signals.statusSnapshot.syncWarning }
    set { signals.updateStatus { $0.syncWarning = newValue } }
  }
  private let syncSleep: @Sendable (Duration) async throws -> Void
  private(set) var conflictingRemote: ComposerDraft? {
    get { signals.statusSnapshot.conflictingRemote }
    set { signals.updateStatus { $0.conflictingRemote = newValue } }
  }
  var contextLabels: [String] { document.contextLabels }
  var canSend: Bool {
    ComposerDraftRules.canSend(
      signals.snapshot, signals.statusSnapshot, attachments.snapshot, voice?.snapshot)
  }
  var hasContent: Bool { ComposerDraftRules.hasContent(signals.snapshot, attachments.snapshot) }
  var currentPresentation: ComposerDraftPresentation { signals.currentPresentation }
  var isDurable: Bool {
    ComposerDraftRules.isDurable(
      persistent: storage != nil, signals.statusSnapshot, attachments.snapshot)
  }
  func requestSync() {
    guard !closed, isForeground, !Task.isCancelled, syncTask == nil else { return }
    let task = Task { [weak self] in await self?.synchronize() }
    lifecycleTasks.track(task)
  }

  func setScenePhase(_ phase: ScenePhase) {
    guard !closed else { return }
    let active = phase == .active
    if !active {
      let pendingStart = voice?.isWaitingToStartCapture == true
      if pendingStart ? phase == .background : isForeground { voice?.suspend() }
    }
    guard isForeground != active else { return }
    isForeground = active
    if active {
      voice?.resumePendingStart()
      // Resume pending writes, including clears owned by a different cached composer.
      if dirty { requestSync() }
    } else {
      persist()
      debounceTask?.cancel()
      // A cancelled task can finish after the next foreground sync has started.
      syncGeneration = UUID()
      syncTask?.cancel()
      syncTask = nil
    }
  }
  private let target: ChatDraftTarget
  private let preservesFeedbackNotes: Bool
  private let repository: ChatDraftRepository?
  private let storage: ChatDraftStorage?
  private let didFail: @MainActor (Error) -> Void
  private let didSave: @MainActor (ComposerDraft) async -> Void
  private var metadata: [ComposerDraft.DraftAttachment] = []
  private var baseline: ComposerDraft?
  private var dirty = false
  private var cleared = false
  private var revision = 0
  private var applying = false
  private var closed: Bool { signals.snapshot.closed }
  private(set) var isForeground: Bool {
    get { signals.statusSnapshot.isForeground }
    set { signals.updateStatus { $0.isForeground = newValue } }
  }
  private var syncGeneration = UUID()
  private var debounceTask: Task<Void, Never>?
  private var syncTask: Task<Void, Never>?

  init(
    target: ChatDraftTarget, commands: ChatCommands, graph: CCState.Store,
    repository: ChatDraftRepository? = nil,
    storage: ChatDraftStorage? = nil, didFail: @escaping @MainActor (Error) -> Void,
    didSave: @escaping @MainActor (ComposerDraft) async -> Void = { _ in },
    voiceCapture: (any VoiceAudioCapture)? = nil,
    syncSleep: @escaping @Sendable (Duration) async throws -> Void = {
      try await Task.sleep(for: $0)
    },
    lifecycleTasks: LifecycleTasks? = nil, preservesFeedbackNotes: Bool = false
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    self.syncSleep = syncSleep
    self.target = target
    self.preservesFeedbackNotes = preservesFeedbackNotes
    self.repository = repository
    self.storage = storage
    self.didFail = didFail
    self.didSave = didSave
    let store = graph
    self.store = store
    editor = ComposerEditor(graph: store)
    let voice =
      target == .unassigned
      ? nil
      : storage.map {
        ComposerVoiceInputStore(
          client: commands.voiceInput, storage: $0.voiceDraft(for: target),
          capture: voiceCapture ?? NativeVoiceAudioCapture(), store: store,
          didRequireUpgrade: didFail)
      }
    self.voice = voice
    let attachments = AttachmentDraftStore(commands: commands, store: store, didFail: didFail)
    self.attachments = attachments
    signals = ComposerDraftSignals(store: store, uploads: attachments.value, voice: voice?.value)
    do {
      if let saved = try storage?.load(target.key, as: LocalRecord.self) {
        document = saved.value.draftUserMessage ?? ChatDraftDocument()
        metadata = saved.value.draftAttachments ?? []
        baseline = saved.baseline
        dirty = saved.dirty
        cleared = saved.cleared
        consumedVoiceID = saved.consumedVoiceID
        attachments.restore(saved.files)
      }
    } catch {
      localReadFailed = true
      localError =
        "Cannot restore the device draft. Clear it explicitly to start again. "
        + error.localizedDescription
      didFail(error)
    }
    resetEditors()
    voice?.composer = self
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
          "filenameSnapshot": .string(file.filename), "contentType": .string(file.contentType)
        ]))
    }
    var persisted = metadata
    for file in files {
      guard let url = file.url else { continue }
      persisted.removeAll { $0.id == file.id }
      persisted.append(ComposerDraft.DraftAttachment(attachment: file, url: url))
    }
    let whitespaceOnly = result.parts.allSatisfy {
      guard $0["type"]?.string == "text", let text = $0["text"]?.string else { return false }
      return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    return ComposerDraft(
      document: result.parts.isEmpty || (whitespaceOnly && persisted.isEmpty) ? nil : result,
      attachments: persisted.isEmpty ? nil : persisted)
  }

  private func changed() {
    guard !closed, !applying else { return }
    revision += 1
    dirty = true
    if hasContent { cleared = false }
    persist()
    debounceTask?.cancel()
    guard isForeground else { return }
    debounceTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
      await self?.synchronize()
    }
    if let debounceTask { lifecycleTasks.track(debounceTask) }
  }

  private func persist() {
    guard !closed, !localReadFailed else { return }
    do {
      try storage?.save(
        LocalRecord(
          value: value, files: attachments.savedItems,
          baseline: baseline, dirty: dirty, cleared: cleared,
          consumedVoiceID: consumedVoiceID), key: target.key)
      localError = nil
    } catch {
      localError = "Cannot save this draft on the device. " + error.localizedDescription
      didFail(error)
    }
  }

  /// Reconciles a confirmed read without replacing concurrent local edits or imports.
  private func reconcileRemote(_ remote: ComposerDraft, startedRevision: Int) -> Bool {
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
        return false
      }
    } else if startedRevision == revision {
      if cleared && remote != value {
        conflictingRemote = remote
        syncError =
          "A draft appeared after this device cleared it. Choose which draft to keep."
        persist()
        return false
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
        return false
      }
    }
    return true
  }

  func synchronize() async {
    guard !closed, isForeground, !Task.isCancelled, !localReadFailed, let repository else { return }
    if let syncTask {
      await syncTask.value
      return
    }
    let generation = syncGeneration
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if syncGeneration == generation { syncTask = nil }
      }
      var retryAttempt = 0
      var retryPending = false
      repeat {
        retryPending = false
        let startedRevision = revision
        do {
          let remote = try await repository.load(target)
          try Task.checkCancellation()
          guard !closed else { return }
          syncWarning = nil
          guard reconcileRemote(remote, startedRevision: startedRevision) else { return }
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
          await didSave(sent)
        } catch is CancellationError { return } catch let missing as UnavailableChatThread {
          guard !closed, !Task.isCancelled else { return }
          didFail(missing)
          return
        } catch {
          guard !closed, !Task.isCancelled else { return }
          persist()
          if let delay = ChatReadRecovery.retryDelay(for: error, attempt: retryAttempt) {
            retryAttempt += 1
            do { try await syncSleep(delay) } catch { return }
            guard !closed, !Task.isCancelled, syncGeneration == generation else { return }
            // Every retry reads the remote draft before writing, preserving conflict detection.
            retryPending = true
          } else {
            report(error)
            return
          }
        }
      } while (dirty || retryPending) && !closed && !Task.isCancelled
    }
    lifecycleTasks.track(task)
    syncTask = task
    await task.value
  }

  func prependSuggestion(_ suggestion: ComposerDraft) async throws {
    await synchronize()
    try Task.checkCancellation()
    guard canEditDocument, syncWarning == nil, error == nil,
      let incoming = suggestion.draftUserMessage, incoming.isSupported
    else { throw ChatError.composerUnavailable }
    let existing = value
    let suffix = existing.draftUserMessage?.parts ?? []
    let separator: [MessageJSON] =
      suffix.isEmpty ? [] : [.object(["type": .string("text"), "text": .string("\n\n")])]
    let files = existing.draftAttachments ?? []
    let existingIDs = Set(files.map(\.id))
    let added = (suggestion.draftAttachments ?? []).filter { !existingIDs.contains($0.id) }
    let referenced = Set(
      incoming.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    guard referenced.isSubset(of: Set((files + added).map(\.id))) else {
      throw ChatError.composerUnavailable
    }
    try attachments.appendRemoteFiles(added)
    document = ChatDraftDocument(parts: incoming.parts + separator + suffix)
    metadata = files + added
    resetEditors()
    changed()
  }

  private func apply(_ remote: ComposerDraft) {
    applying = true
    document = remote.draftUserMessage ?? ChatDraftDocument()
    metadata = remote.draftAttachments ?? []
    resetEditors()
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
    if let voice, voice.phase != .idle {
      voice.suspend()
      let task = Task { await voice.discard() }
      lifecycleTasks.track(task)
    }
    // Native focus callbacks must finish while their editor generation is still current.
    editor.dismissKeyboard()
    localReadFailed = false
    cleared = true
    applying = true
    document = ChatDraftDocument()
    resetEditors()
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
    destination.resetEditors()
    attachments.moveReadyFiles(to: destination.attachments)
    destination.applying = false
    destination.changed()
    clear()
  }

  func close(discardingDraft: Bool = false) {
    guard !closed else { return }
    voice?.suspend()
    if !discardingDraft { persist() }
    editor.dismissKeyboard()
    if discardingDraft {
      document = ChatDraftDocument()
      metadata = []
      baseline = nil
      conflictingRemote = nil
      if let voice {
        let task = Task { await voice.discard() }
        lifecycleTasks.track(task)
      }
    }
    signals.close()
    debounceTask?.cancel()
    syncTask?.cancel()
    attachments.close(preserveFiles: storage != nil && !discardingDraft)
  }

  private func report(_ failure: Error) {
    didFail(failure)
    if (failure as? URLError)?.code == .cancelled { return }
    let status = (failure as? APIClientError)?.statusCode
    guard status != 401, status != 426 else { return }
    syncWarning = "This draft has not synced to your other devices. Try again when connected."
  }
}

extension ComposerDraftStore {
  static func removeStoredDraft(_ id: String, from storage: ChatDraftStorage) throws {
    // A released conversation can still own imported files outside its serialized draft.
    let key = ChatDraftTarget.thread(id).key
    if let record = try? storage.load(key, as: LocalRecord.self) {
      for item in record.files { item.file.remove() }
    }
    try storage.removeThreadDraft(id)
  }
}
