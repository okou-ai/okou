import Foundation

/// Whether the workspace may still use speech input today (`GET /api/voice-io/quota`).
public struct ChatVoiceQuota: Decodable, Equatable, Sendable {
  public let allowed: Bool
  public let count: Int
  public let limit: Int?
}

/// The web's voice-draft pipeline: 16 kHz mono 16-bit WAV segments are transcribed in order,
/// each with the transcript so far, then the segment transcripts are polished into one text.
extension APIClient {
  public func voiceQuota() async throws -> ChatVoiceQuota {
    try await request("/api/voice-io/quota")
  }

  /// Returns nil when the segment held no intelligible speech (HTTP 204).
  public func transcribeVoiceSegment(
    wav: Data, previousTranscript: String, overlapSeconds: Double, totalSeconds: Double
  ) async throws -> String? {
    struct Options: Encodable {
      let previousTranscript: String
      let overlapDurationSeconds: Double
      let totalDurationSeconds: Double
    }
    let options = try JSONEncoder().encode(
      Options(
        previousTranscript: String(previousTranscript.suffix(1000)),
        overlapDurationSeconds: min(2, max(0, overlapSeconds)),
        totalDurationSeconds: min(3600, max(0, totalSeconds))))
    let boundary = "okou-voice-\(UUID().uuidString)"
    var body = Data()
    body.append(Data("--\(boundary)\r\n".utf8))
    body.append(Data("Content-Disposition: form-data; name=\"options\"\r\n".utf8))
    body.append(Data("Content-Type: application/json\r\n\r\n".utf8))
    body.append(options)
    body.append(Data("\r\n--\(boundary)\r\n".utf8))
    body.append(
      Data("Content-Disposition: form-data; name=\"file\"; filename=\"segment.wav\"\r\n".utf8))
    body.append(Data("Content-Type: audio/wav\r\n\r\n".utf8))
    body.append(wav)
    body.append(Data("\r\n--\(boundary)--\r\n".utf8))
    let response = try await data(
      "/api/voice-io/transcribe/segment", method: "POST", body: body,
      headers: ["Content-Type": "multipart/form-data; boundary=\(boundary)"])
    if response.response.statusCode == 204 { return nil }
    struct Transcript: Decodable { let transcript: String }
    guard let transcript = try? Self.decoder().decode(Transcript.self, from: response.data)
    else { throw APIClientError.incompatibleData }
    let text = transcript.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  /// Joins and cleans the segment transcripts into send-ready text.
  public func polishVoiceSegments(_ segments: [String]) async throws -> String {
    struct Demand: Encodable { let segments: [String] }
    struct Polished: Decodable { let text: String }
    let result: Polished = try await request(
      "/api/voice-io/polish/segments", method: "POST",
      body: JSONEncoder().encode(Demand(segments: Array(segments.prefix(128)))))
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

/// A 16 kHz mono 16-bit little-endian PCM WAV container, the only format the API accepts.
public enum ChatVoiceWAV {
  public static let sampleRate = 16_000

  public static func encode(_ samples: [Int16]) -> Data {
    let dataSize = samples.count * 2
    var data = Data(capacity: 44 + dataSize)
    func append<T: FixedWidthInteger>(_ value: T) {
      withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
    data.append(Data("RIFF".utf8))
    append(UInt32(36 + dataSize))
    data.append(Data("WAVEfmt ".utf8))
    append(UInt32(16))
    append(UInt16(1))
    append(UInt16(1))
    append(UInt32(sampleRate))
    append(UInt32(sampleRate * 2))
    append(UInt16(2))
    append(UInt16(16))
    data.append(Data("data".utf8))
    append(UInt32(dataSize))
    for sample in samples { append(sample) }
    return data
  }
}
