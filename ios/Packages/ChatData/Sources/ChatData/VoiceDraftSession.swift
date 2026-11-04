import Foundation

public enum VoiceDraftError: LocalizedError {
  case unavailable, changed, durationLimit

  public var errorDescription: String? {
    switch self {
    case .unavailable: "Cannot restore this recording. Discard it to start another."
    case .changed: "This recording changed. Reopen the draft and try again."
    case .durationLimit: "The one-hour recording limit was reached. Your recording is saved."
    }
  }
}

public struct VoiceDraftStorage: Sendable {
  let directory: URL

  public init(directory: URL) { self.directory = directory }

  public var hasRecording: Bool {
    FileManager.default.fileExists(atPath: directory.path)
  }

  public func remove() throws {
    if hasRecording { try FileManager.default.removeItem(at: directory) }
  }
}

/// Audio bytes and completed segments survive process exit independently of HTTP work.
/// One composer owns a session; cancellation never removes its recovery files.
public actor VoiceDraftSession {
  public static let sampleRate = 16_000
  private static let segmentSamples = 15 * sampleRate
  private static let overlapSamples = 2 * sampleRate
  private static let maximumBytes = 60 * 60 * sampleRate * 2

  private struct Segment: Codable {
    let endSample: Int
    let transcript: String
  }
  private struct Record: Codable {
    let id: UUID
    let context: VoiceEditorContext
    var segments: [Segment] = []
    var text: String?
  }

  public nonisolated let restoredRecordingID: UUID?
  public nonisolated let restoredDuration: Double
  private let storage: VoiceDraftStorage
  private let client: VoiceInputClient
  private var record: Record?
  private var sampleCount: Int

  public init(client: VoiceInputClient, storage: VoiceDraftStorage) throws {
    self.client = client
    self.storage = storage
    if storage.hasRecording {
      let saved = try JSONDecoder().decode(
        Record.self, from: Data(contentsOf: storage.directory.appendingPathComponent("record.json"))
      )
      let size =
        try storage.directory.appendingPathComponent("audio.pcm")
        .resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size.isMultiple(of: 2), size <= Self.maximumBytes,
        (saved.segments.last?.endSample ?? 0) <= size / 2
      else { throw VoiceDraftError.unavailable }
      record = saved
      sampleCount = size / 2
    } else {
      sampleCount = 0
    }
    restoredRecordingID = record?.id
    restoredDuration = Double(sampleCount) / Double(Self.sampleRate)
  }

  public func begin(context: VoiceEditorContext) throws -> UUID {
    guard record == nil, !storage.hasRecording else { throw VoiceDraftError.changed }
    try FileManager.default.createDirectory(
      at: storage.directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var directory = storage.directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    try Data().write(
      to: directory.appendingPathComponent("audio.pcm"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    let saved = Record(id: UUID(), context: context)
    try save(saved)
    record = saved
    sampleCount = 0
    return saved.id
  }

  public func append(_ pcm: Data, recordingID: UUID) throws -> Double {
    guard record?.id == recordingID else { throw VoiceDraftError.changed }
    guard pcm.count.isMultiple(of: 2) else { throw VoiceDraftError.unavailable }
    let remaining = Self.maximumBytes - sampleCount * 2
    let bytes = pcm.prefix(remaining)
    let file = try FileHandle(forWritingTo: storage.directory.appendingPathComponent("audio.pcm"))
    defer { try? file.close() }
    try file.seekToEnd()
    try file.write(contentsOf: bytes)
    sampleCount += bytes.count / 2
    if bytes.count < pcm.count { throw VoiceDraftError.durationLimit }
    return Double(sampleCount) / Double(Self.sampleRate)
  }

  public func transcribeAvailable(recordingID: UUID, finished: Bool = false) async throws {
    while let current = record, current.id == recordingID {
      let previousEnd = current.segments.last?.endSample ?? 0
      guard previousEnd < sampleCount else { return }
      let start = max(0, previousEnd - Self.overlapSamples)
      let end = min(sampleCount, start + Self.segmentSamples)
      if !finished && end - start < Self.segmentSamples { return }
      let file = try FileHandle(
        forReadingFrom: storage.directory.appendingPathComponent("audio.pcm"))
      let pcm: Data
      do {
        try file.seek(toOffset: UInt64(start * 2))
        pcm = try file.read(upToCount: (end - start) * 2) ?? Data()
        try file.close()
      } catch {
        try? file.close()
        throw error
      }
      let previous = String(current.segments.map(\.transcript).joined(separator: " ").suffix(1_000))
      let transcript = try await client.transcribe(
        pcm: pcm, previousTranscript: previous,
        overlapSeconds: Double(previousEnd - start) / Double(Self.sampleRate),
        totalSeconds: Double(sampleCount) / Double(Self.sampleRate), context: current.context)
      try Task.checkCancellation()
      guard var updated = record, updated.id == recordingID,
        (updated.segments.last?.endSample ?? 0) == previousEnd
      else { throw VoiceDraftError.changed }
      updated.segments.append(Segment(endSample: end, transcript: transcript))
      try save(updated)
      record = updated
    }
    throw CancellationError()
  }

  public func finish(recordingID: UUID) async throws -> String {
    try await transcribeAvailable(recordingID: recordingID, finished: true)
    guard let current = record, current.id == recordingID else { throw VoiceDraftError.changed }
    if let text = current.text { return text }
    let text = try await client.polish(current.segments.map(\.transcript))
    try Task.checkCancellation()
    guard var updated = record, updated.id == recordingID else { throw VoiceDraftError.changed }
    updated.text = text
    try save(updated)
    record = updated
    return text
  }

  public func discard() throws {
    try storage.remove()
    record = nil
    sampleCount = 0
  }

  private func save(_ value: Record) throws {
    try JSONEncoder().encode(value).write(
      to: storage.directory.appendingPathComponent("record.json"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func wav(_ pcm: Data) -> Data {
    var result = Data()
    func ascii(_ value: String) { result.append(Data(value.utf8)) }
    func integer<T: FixedWidthInteger>(_ value: T) {
      var little = value.littleEndian
      withUnsafeBytes(of: &little) { result.append(contentsOf: $0) }
    }
    ascii("RIFF")
    integer(UInt32(36 + pcm.count))
    ascii("WAVEfmt ")
    integer(UInt32(16))
    integer(UInt16(1))
    integer(UInt16(1))
    integer(UInt32(sampleRate))
    integer(UInt32(sampleRate * 2))
    integer(UInt16(2))
    integer(UInt16(16))
    ascii("data")
    integer(UInt32(pcm.count))
    result.append(pcm)
    return result
  }
}
