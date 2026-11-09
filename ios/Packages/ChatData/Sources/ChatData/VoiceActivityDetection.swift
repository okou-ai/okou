import Foundation

/// The native inference adapter must preserve weak or uncertain speech. Only a
/// confirmed no-speech result may suppress an upload of the supplied new PCM.
public protocol VoiceActivityDetection: Sendable {
  var policyVersion: String { get }
  func mayContainSpeech(_ pcm: Data) async throws -> Bool
}
