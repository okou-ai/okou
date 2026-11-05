import ChatData
import Foundation
import Observation

/// Lives with the immutable workspace owner, including when the editor sheet closes.
@MainActor @Observable
final class PersonalInstructionsStore {
  private struct Draft: Codable {
    let content: String
    let savedContent: String
    let version: String
  }
  private struct Stored: Codable { let draft: Draft? }
  private let client: PersonalInstructionsClient
  private let storage: ChatDraftStorage?
  private let didFail: @MainActor (Error) -> Void
  private var draft: Draft?
  private(set) var saved: PersonalInstructions?
  private(set) var content = ""
  private(set) var error: String?
  private(set) var conflict = false
  private(set) var isLoading = false
  private(set) var isSaving = false
  private var closed = false
  private var loadTask: Task<Void, Never>?
  private var saveTask: Task<Void, Never>?
  var isDirty: Bool { draft.map { $0.content != $0.savedContent } ?? false }

  init(client: APIClient, storage: ChatDraftStorage?, didFail: @escaping @MainActor (Error) -> Void)
  {
    self.client = PersonalInstructionsClient(client: client)
    self.storage = storage
    self.didFail = didFail
    do {
      draft = try storage?.load("personal-instructions", as: Stored.self)?.draft
      content = draft?.content ?? ""
    } catch { self.error = error.localizedDescription }
  }

  func edit(_ text: String) {
    guard !closed, !isSaving, let saved else { return }
    content = text
    draft = Draft(
      content: text, savedContent: draft?.savedContent ?? saved.content,
      version: draft?.version ?? saved.version)
    persist()
  }

  func load(discardDraft: Bool = false) async {
    guard !closed, !isSaving else { return }
    if let loadTask {
      await loadTask.value
      return
    }
    isLoading = true
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isLoading = false
        loadTask = nil
      }
      do {
        let response = try await client.load()
        try Task.checkCancellation()
        guard !closed else { return }
        if discardDraft {
          draft = nil
          conflict = false
          persist()
        }
        saved = response
        content = draft?.content ?? response.content
        error = nil
      } catch is CancellationError { return } catch {
        guard !closed, !Task.isCancelled else { return }
        self.error = error.localizedDescription
        didFail(error)
      }
    }
    loadTask = task
    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }

  func save() async {
    guard !closed, !isSaving, !isLoading, !conflict, let draft else { return }
    isSaving = true
    error = nil
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        isSaving = false
        saveTask = nil
      }
      do {
        let response = try await client.save(content: draft.content, ifVersion: draft.version)
        try Task.checkCancellation()
        guard !closed else { return }
        saved = response
        content = response.content
        self.draft = nil
        conflict = false
        persist()
      } catch is CancellationError { return } catch let failure as APIClientError
        where failure.statusCode == 409
      {
        guard !closed, !Task.isCancelled else { return }
        conflict = true
      } catch {
        guard !closed, !Task.isCancelled else { return }
        self.error = error.localizedDescription
        didFail(error)
      }
    }
    saveTask = task
    await withTaskCancellationHandler {
      await task.value
    } onCancel: {
      task.cancel()
    }
  }

  /// Only an explicit Discard/Reload may replace the retained local draft.
  func discard() async {
    guard !closed, !isSaving else { return }
    await load(discardDraft: true)
  }

  private func persist() {
    do { try storage?.save(Stored(draft: draft), key: "personal-instructions") } catch {
      self.error = error.localizedDescription
    }
  }

  func close() {
    closed = true
    loadTask?.cancel()
    saveTask?.cancel()
  }
}
