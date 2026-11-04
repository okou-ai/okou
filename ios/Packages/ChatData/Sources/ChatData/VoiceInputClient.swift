import Foundation

public struct VoiceEditorContext: Codable, Sendable {
  public let before: String
  public let selected: String
  public let after: String

  public init(before: String, selected: String, after: String) {
    self.before = String(decoding: before.utf16.suffix(1_000), as: UTF16.self)
    self.selected = String(decoding: selected.utf16.prefix(1_000), as: UTF16.self)
    self.after = String(decoding: after.utf16.prefix(1_000), as: UTF16.self)
  }
}

public struct VoiceInputQuota: Decodable, Sendable {
  public let allowed: Bool
  public let count: Int
  public let limit: Int?
}

/// Uses the same organization-scoped session and voice contracts as the PWA.
public struct VoiceInputClient: Sendable {
  private let client: APIClient

  public init(client: APIClient) { self.client = client }

  public func quota() async throws -> VoiceInputQuota {
    try await client.request("/api/voice-io/quota")
  }

  public func transcribe(
    pcm: Data, previousTranscript: String, overlapSeconds: Double,
    totalSeconds: Double, context: VoiceEditorContext
  ) async throws -> String {
    struct Options: Encodable {
      let previousTranscript: String
      let overlapDurationSeconds: Double
      let totalDurationSeconds: Double
    }
    let boundary = "OkouVoice-" + UUID().uuidString
    var body = Data()
    func field(_ name: String, _ data: Data, filename: String? = nil) {
      var header = "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\""
      if let filename { header += "; filename=\"\(filename)\"\r\nContent-Type: audio/wav" }
      body.append(Data((header + "\r\n\r\n").utf8))
      body.append(data)
      body.append(Data("\r\n".utf8))
    }
    field("file", VoiceDraftSession.wav(pcm), filename: "segment.wav")
    field(
      "options",
      try JSONEncoder().encode(
        Options(
          previousTranscript: String(
            decoding: previousTranscript.utf16.suffix(1_000), as: UTF16.self),
          overlapDurationSeconds: overlapSeconds, totalDurationSeconds: totalSeconds)))
    field("editorContext", try JSONEncoder().encode(context))
    body.append(Data("--\(boundary)--\r\n".utf8))
    let response = try await client.data(
      "/api/voice-io/transcribe/segment", method: "POST", body: body,
      headers: ["Content-Type": "multipart/form-data; boundary=\(boundary)"])
    if response.response.statusCode == 204 { return "" }
    struct Transcript: Decodable {
      let transcript: String
      let language: String
    }
    return try JSONDecoder().decode(Transcript.self, from: response.data).transcript
  }

  public func polish(_ segments: [String]) async throws -> String {
    struct Request: Encodable { let segments: [String] }
    struct Response: Decodable { let text: String }
    let nonempty = segments.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    guard !nonempty.isEmpty else { return "" }
    // Packing preserves every checkpoint while respecting the shared 128-segment limit.
    let groupSize = max(1, (nonempty.count + 127) / 128)
    let packed = stride(from: 0, to: nonempty.count, by: groupSize).map {
      nonempty[$0..<min($0 + groupSize, nonempty.count)].joined(separator: " ")
    }
    let result: Response = try await client.request(
      "/api/voice-io/polish/segments", method: "POST",
      body: JSONEncoder().encode(Request(segments: packed)))
    return result.text
  }
}
