import ChatData
import ChatDomain
import Foundation
import Observation
import PhotosUI
import SwiftUI

@MainActor @Observable
final class AttachmentDraftStore {
  struct Item: Identifiable {
    let id: UUID
    init(id: UUID = UUID(), file: ImportedAttachmentFile, state: UploadState = .waiting) {
      self.id = id
      self.file = file
      self.state = state
    }
    let file: ImportedAttachmentFile
    var state: UploadState = .waiting
  }
  enum UploadState {
    case waiting
    case uploading(Double)
    case ready(ChatAttachment)
    case checking(ChatAttachment)
    case failed(String)
  }

  struct SavedItem: Codable, Equatable {
    let file: ImportedAttachmentFile
    let uploaded: ChatAttachment?
  }
  var didRemove: (@MainActor (String?) -> Void)?
  var didChange: (@MainActor () -> Void)?
  private(set) var inputID = UUID()
  private(set) var items: [Item] = []
  var savedItems: [SavedItem] {
    items.map { item in
      let uploaded: ChatAttachment?
      switch item.state {
      case .ready(let file), .checking(let file): uploaded = file
      default: uploaded = remoteFiles[item.id]
      }
      return SavedItem(file: item.file, uploaded: uploaded)
    }
  }

  func restore(_ saved: [SavedItem]) {
    for task in uploads.values { task.cancel() }
    uploads.removeAll()
    remoteFiles.removeAll()
    items = saved.map { saved in
      let item = Item(
        file: saved.file,
        state: saved.uploaded.map(UploadState.checking)
          ?? .failed("Upload interrupted. Retry, or remove this file and select it again."))
      if let uploaded = saved.uploaded { remoteFiles[item.id] = uploaded }
      return item
    }
    for item in items { validateRemote(item) }
  }

  func restoreRemote(_ draft: ComposerDraft) {
    let parts = draft.draftUserMessage?.parts ?? []
    let ids = Set(parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    let metadata = draft.draftAttachments ?? []
    let saved = metadata.filter { ids.contains($0.id) }.compactMap { file -> SavedItem? in
      guard let url = URL(string: file.url), !url.isFileURL else { return nil }
      return SavedItem(
        file: ImportedAttachmentFile(
          url: url, filename: file.filename,
          contentType: file.contentType, size: file.size, thumbnail: nil), uploaded: file.attachment
      )
    }
    reset()
    restore(saved)
    if !ids.isSubset(of: Set(saved.compactMap { $0.uploaded?.id })) {
      error = "Some draft files have no recoverable metadata. Open this draft on the web."
    }
  }

  private func validateRemote(_ item: Item) {
    let file: ChatAttachment
    switch item.state {
    case .ready(let value), .checking(let value): file = value
    default: return
    }
    uploads[item.id] = Task { [weak self] in
      guard let self else { return }
      defer { uploads[item.id] = nil }
      do {
        try await commands.validateAttachment(file.id)
        try Task.checkCancellation()
        guard !closed else { return }
        update(item.id, .ready(file))
      } catch {
        guard !closed, !Task.isCancelled else { return }
        let message = "Cannot restore \(item.file.filename). " + error.localizedDescription
        self.error = message
        update(item.id, .failed(message))
        didFail(error)
      }
    }
  }
  private(set) var importingCount = 0
  var error: String?
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]
  @ObservationIgnored private var imports: [UUID: Task<Void, Never>] = [:]
  private var closed = false
  private var remoteFiles: [UUID: ChatAttachment] = [:]

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

  func importPastedImages(_ providers: [NSItemProvider]) {
    startImport {
      for provider in providers {
        try Task.checkCancellation()
        do {
          let file = try await AttachmentFileImporter.image(from: provider)
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
    didChange?()
    startUploads()
  }

  private func startUploads() {
    guard !closed else { return }
    for item in items where uploads.count < 3 {
      guard case .waiting = item.state else { continue }
      guard item.file.url.isFileURL else { continue }
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

  private func savedRemoteAttachment(_ id: UUID) -> ChatAttachment? { remoteFiles[id] }

  func retry(_ id: UUID) {
    guard let item = items.first(where: { $0.id == id }), case .failed = item.state else { return }
    if let file = savedRemoteAttachment(id) {
      update(id, .checking(file))
      validateRemote(Item(id: item.id, file: item.file, state: .checking(file)))
      return
    }
    update(id, .waiting)
    startUploads()
  }

  func remove(_ id: UUID) {
    let fileID: String? = items.first(where: { $0.id == id }).flatMap {
      switch $0.state {
      case .ready(let file), .checking(let file): return file.id
      default: break
      }
      return remoteFiles[id]?.id
    }
    remoteFiles[id] = nil
    uploads.removeValue(forKey: id)?.cancel()
    items.first(where: { $0.id == id })?.file.remove()
    items.removeAll { $0.id == id }
    didRemove?(fileID)
    didChange?()
    startUploads()
  }

  func moveReadyFiles(to destination: AttachmentDraftStore) {
    guard isReady, !closed else { return }
    destination.items.append(contentsOf: items)
    destination.remoteFiles.merge(remoteFiles) { current, _ in current }
    items.removeAll()
    remoteFiles.removeAll()
    destination.didChange?()
    didChange?()
  }

  func reset() {
    // A native text paste can finish asynchronously too. Replacing the input
    // detaches its binding when this draft is reset for a send or another agent.
    inputID = UUID()
    for task in imports.values { task.cancel() }
    for task in uploads.values { task.cancel() }
    imports.removeAll()
    uploads.removeAll()
    remoteFiles.removeAll()
    importingCount = 0
    for item in items { item.file.remove() }
    items.removeAll()
    error = nil
    didChange?()
  }

  func close(preserveFiles: Bool = false) {
    closed = true
    if preserveFiles {
      for task in imports.values { task.cancel() }
      for task in uploads.values { task.cancel() }
      imports.removeAll()
      uploads.removeAll()
      importingCount = 0
      items.removeAll()
    } else {
      reset()
    }
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
    let previous = savedItems
    items[index].state = state
    if previous != savedItems { didChange?() }
  }
}
