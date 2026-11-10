import ChatData
import ChatDomain
import Foundation
import Observation
import UIKit

/// Detail-scoped downloads. Leaving the detail or closing its workspace cancels all work.
@MainActor @Observable
final class MessageAttachmentStore {
  struct Preview: Identifiable {
    let id = UUID()
    let attachment: ChatMessageAttachment
    let thumbnail: UIImage?
    var file: ChatAttachmentFile?
    var error: String?
    var canRetry = true
  }

  private(set) var preview: Preview?
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private var downloads: [UUID: Task<ChatAttachmentFile?, Error>] = [:]
  private(set) var reads: MessageAttachmentResources
  private var previewTask: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
    reads = MessageAttachmentResources(commands: commands, didFail: didFail)
  }

  func cachedThumbnail(_ attachment: ChatMessageAttachment) -> UIImage? {
    guard !closed else { return nil }
    return reads.cachedThumbnail(attachment)
  }

  func open(_ attachment: ChatMessageAttachment) {
    guard !closed else { return }
    previewTask?.cancel()
    let artifact = ChatArtifact(
      source: .file(attachment.downloadID), filename: attachment.filename,
      contentType: attachment.contentType, size: attachment.size)
    let item = Preview(
      attachment: attachment, thumbnail: cachedThumbnail(attachment),
      file: commands.artifacts.uploadedFile(artifact))
    preview = item
    if item.file != nil { return }
    previewTask = Task { [weak self] in
      guard let self else { return }
      do {
        let file = try await download(attachment, thumbnail: false)
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.file = file
      } catch {
        guard !Task.isCancelled, preview?.id == item.id else { return }
        preview?.error = Self.message(for: error)
        preview?.canRetry = ChatRequestFailure.canRetry(error)
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
    reads.close()
    if !closed { reads = MessageAttachmentResources(commands: commands, didFail: didFail) }
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
    let task = Task<ChatAttachmentFile?, Error> {
      try await commands.downloadAttachment(attachment, thumbnail: thumbnail)
    }
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
    case 404, 410: "This attachment was deleted or is no longer available."
    default: ChatRequestFailure.message(for: error)
    }
  }
}
