import ChatData
import ChatDomain
import Foundation
import Observation
import PhotosUI
import SwiftUI

@MainActor @Observable
final class AttachmentDraftStore {
  struct Item: Identifiable {
    let id = UUID()
    let file: ImportedAttachmentFile
    var state: UploadState = .waiting
  }
  enum UploadState {
    case waiting
    case uploading(Double)
    case ready(ChatAttachment)
    case failed(String)
  }

  private(set) var items: [Item] = []
  private(set) var importingCount = 0
  var error: String?
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]
  @ObservationIgnored private var imports: [UUID: Task<Void, Never>] = [:]
  private var closed = false

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
  }

  var hasAttachments: Bool { !items.isEmpty || importingCount > 0 }
  var isReady: Bool {
    importingCount == 0
      && items.allSatisfy {
        if case .ready = $0.state { return true }
        return false
      }
  }
  var uploaded: [ChatAttachment] {
    items.compactMap { if case .ready(let file) = $0.state { file } else { nil } }
  }

  func importFiles(_ urls: [URL]) {
    startImport {
      for url in urls {
        try Task.checkCancellation()
        do {
          let file = try await AttachmentFileImporter.shared.copy(url)
          self.add(file)
        } catch { self.report(error) }
      }
    }
  }

  func importPhotos(_ photos: [PhotosPickerItem]) {
    startImport {
      for photo in photos {
        try Task.checkCancellation()
        do {
          guard let file = try await photo.loadTransferable(type: ImportedAttachmentFile.self)
          else {
            throw ChatError.invalidContract(
              "This photo or video could not be loaded. Select it again.")
          }
          self.add(file)
        } catch { self.report(error) }
      }
    }
  }

  private func startImport(_ operation: @escaping @MainActor () async throws -> Void) {
    guard !closed else { return }
    let id = UUID()
    importingCount += 1
    imports[id] = Task { [weak self] in
      guard let self else { return }
      defer {
        if imports.removeValue(forKey: id) != nil { importingCount -= 1 }
      }
      do { try await operation() } catch { report(error) }
    }
  }

  private func add(_ file: ImportedAttachmentFile) {
    guard !closed, !Task.isCancelled else {
      file.remove()
      return
    }
    items.append(Item(file: file))
    startUploads()
  }

  private func startUploads() {
    guard !closed else { return }
    for item in items where uploads.count < 3 {
      guard case .waiting = item.state else { continue }
      update(item.id, .uploading(0))
      uploads[item.id] = Task { [weak self] in
        guard let self else { return }
        defer {
          uploads[item.id] = nil
          startUploads()
        }
        do {
          let uploaded = try await commands.uploadAttachment(
            file: item.file.url, filename: item.file.filename, contentType: item.file.contentType
          ) { [weak self] fraction in
            Task { @MainActor [weak self] in
              guard let self, let current = items.first(where: { $0.id == item.id }),
                case .uploading = current.state
              else { return }
              update(item.id, .uploading(fraction))
            }
          }
          try Task.checkCancellation()
          update(item.id, .ready(uploaded))
        } catch {
          guard !Task.isCancelled, !closed else { return }
          update(item.id, .failed(error.localizedDescription))
          didFail(error)
        }
      }
    }
  }

  func retry(_ id: UUID) {
    guard let item = items.first(where: { $0.id == id }), case .failed = item.state else { return }
    update(id, .waiting)
    startUploads()
  }

  func remove(_ id: UUID) {
    uploads.removeValue(forKey: id)?.cancel()
    items.first(where: { $0.id == id })?.file.remove()
    items.removeAll { $0.id == id }
    startUploads()
  }

  func moveReadyFiles(to destination: AttachmentDraftStore) {
    guard isReady, !closed else { return }
    destination.items.append(contentsOf: items)
    items.removeAll()
  }

  func reset() {
    for task in imports.values { task.cancel() }
    for task in uploads.values { task.cancel() }
    imports.removeAll()
    uploads.removeAll()
    importingCount = 0
    for item in items { item.file.remove() }
    items.removeAll()
    error = nil
  }

  func close() {
    closed = true
    reset()
  }

  func report(_ failure: Error) {
    guard !closed, !Task.isCancelled, (failure as? CocoaError)?.code != .userCancelled else {
      return
    }
    error = failure.localizedDescription
    didFail(failure)
  }

  private func update(_ id: UUID, _ state: UploadState) {
    guard !closed, let index = items.firstIndex(where: { $0.id == id }) else { return }
    items[index].state = state
  }
}
