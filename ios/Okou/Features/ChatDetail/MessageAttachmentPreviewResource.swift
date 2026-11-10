import CCState
import ChatData
import ChatDomain
import Foundation
import UIKit

/// One presentation owns the original file read; ChatCommands still owns retained file bytes.
@MainActor
final class MessageAttachmentPreviewResource: Identifiable {
  let id = UUID()
  let attachment: ChatMessageAttachment
  let thumbnail: UIImage?
  let store = CCState.Store()
  private let lifetime = CCState.State(true)
  private let revision = CCState.State(0)
  private let reload: Command<Void, Void>
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private var request: Task<ChatAttachmentFile?, Error>?
  private var closed = false

  init(
    attachment: ChatMessageAttachment, thumbnail: UIImage?, commands: ChatCommands,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.attachment = attachment
    self.thumbnail = thumbnail
    self.commands = commands
    self.didFail = didFail
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var file = makeFile()

  private func makeFile() -> Computed<Task<ChatAttachmentFile?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      // A 401/426 can close the conversation. Report it after graph evaluation ends.
      let task = Task<ChatAttachmentFile?, Error> { @MainActor [weak self, commands, attachment] in
        do {
          try Task.checkCancellation()
          guard self?.closed == false else { throw CancellationError() }
          let artifact = ChatArtifact(
            source: .file(attachment.downloadID), filename: attachment.filename,
            contentType: attachment.contentType, size: attachment.size)
          let file: ChatAttachmentFile?
          if let uploaded = commands.artifacts.uploadedFile(artifact) {
            file = uploaded
          } else {
            file = try await commands.downloadAttachment(attachment, thumbnail: false)
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard self?.closed == false else { throw CancellationError() }
          return file
        } catch {
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard self?.closed == false else { throw CancellationError() }
          if let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status) {
            self?.didFail(error)
          }
          throw error
        }
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func retry() {
    guard !closed else { return }
    request?.cancel()
    // This command changes only the local revision; I/O errors stay in the original Task.
    do { try store.set(reload) } catch {
      preconditionFailure("Cannot retry local attachment preview inputs: \(error)")
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    request?.cancel()
    request = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { request?.cancel() }
}
