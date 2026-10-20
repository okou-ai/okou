import ChatData
import ChatDomain
import Foundation
import Observation

/// Detail-scoped downloads. Leaving the detail or closing its workspace cancels all work.
@MainActor @Observable
final class MessageAttachmentStore {
  struct Preview: Identifiable {
    let id = UUID()
    let attachment: ChatMessageAttachment
    var file: ChatAttachmentFile?
    var error: String?
  }

  private(set) var preview: Preview?
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private var downloads: [UUID: Task<ChatAttachmentFile?, Error>] = [:]
  private var previewTask: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
  }

  func thumbnail(_ attachment: ChatMessageAttachment) async throws -> Data? {
    let scope = generation
    guard let file = try await download(attachment, thumbnail: true) else { return nil }
    let data = await AttachmentFileImporter.shared.thumbnail(file.url, maximumPixelSize: 600)
    try Task.checkCancellation()
    guard !closed, generation == scope else { throw CancellationError() }
    return data
  }

  func open(_ attachment: ChatMessageAttachment) {
    guard !closed else { return }
    previewTask?.cancel()
    let item = Preview(attachment: attachment)
    preview = item
    previewTask = Task { [weak self] in
      guard let self else { return }
      do {
        let file = try await download(attachment, thumbnail: false)
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.file = file
      } catch {
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.error = Self.message(for: error)
      }
    }
  }

  func dismiss() {
    previewTask?.cancel()
    previewTask = nil
    preview = nil
  }

  func deactivate() {
    generation = UUID()
    dismiss()
    for task in downloads.values { task.cancel() }
    downloads.removeAll()
  }

  func close() {
    closed = true
    deactivate()
  }

  private func download(_ attachment: ChatMessageAttachment, thumbnail: Bool) async throws
    -> ChatAttachmentFile?
  {
    guard !closed else { throw CancellationError() }
    let scope = generation
    let id = UUID()
    let task = Task { try await commands.downloadAttachment(attachment, thumbnail: thumbnail) }
    downloads[id] = task
    defer { downloads[id] = nil }
    do {
      let file = try await withTaskCancellationHandler {
        try await task.value
      } onCancel: {
        task.cancel()
      }
      try Task.checkCancellation()
      guard !closed, generation == scope else { throw CancellationError() }
      return file
    } catch {
      if !closed, generation == scope, !Task.isCancelled,
        let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status)
      {
        didFail(error)
      }
      throw error
    }
  }

  static func message(for error: Error) -> String {
    switch (error as? APIClientError)?.statusCode {
    case 403: "You do not have permission to view this attachment."
    case 404: "This attachment was deleted or is no longer available."
    default: error.localizedDescription
    }
  }
}
