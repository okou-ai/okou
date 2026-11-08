import ChatData
import Foundation
import OnnxRuntimeBindings

/// Matches the PWA's silero-v5-conservative-1 policy and its pinned model.
/// Model SHA-256: 2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f.
/// A session and recurrent state belong to one analysis, off the UI actor.
actor NativeVoiceActivityDetection: VoiceActivityDetection {
  nonisolated let policyVersion = "silero-v5-conservative-1"
  private static let frameSamples = 512

  func mayContainSpeech(_ pcm: Data) throws -> Bool {
    try Task.checkCancellation()
    guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else {
      throw DetectionError.invalidAudio
    }
    if pcm.allSatisfy({ $0 == 0 }) { return false }
    let sampleCount = pcm.count / 2
    // A short word or onset is insufficient evidence to discard speech.
    if sampleCount < Self.frameSamples { return true }
    guard
      let model = Bundle.main.url(
        forResource: "silero-vad-v5-2623a2953f6f", withExtension: "onnx")
    else { throw DetectionError.missingModel }
    let inference = try SileroInference(model: model)
    let samples = pcm.withUnsafeBytes { bytes in
      stride(from: 0, to: pcm.count, by: 2).map {
        Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: $0, as: Int16.self))) / 32_768
      }
    }
    for offset in stride(from: 0, to: sampleCount, by: Self.frameSamples) {
      try Task.checkCancellation()
      var frame = [Float](repeating: 0, count: Self.frameSamples)
      let end = min(offset + Self.frameSamples, sampleCount)
      frame.replaceSubrange(0..<(end - offset), with: samples[offset..<end])
      let probability = try inference.probability(frame)
      guard probability.isFinite, (0...1).contains(probability) else {
        throw DetectionError.invalidOutput
      }
      // PWA passes both speech (>= 0.5) and uncertain (> 0.1) unchanged.
      if Double(probability) > 0.1 { return true }
    }
    try Task.checkCancellation()
    return false
  }

  private enum DetectionError: Error {
    case invalidAudio, missingModel, invalidOutput
  }

  private final class SileroInference {
    private let environment: ORTEnv
    private let session: ORTSession
    private let sampleRate: ORTValue
    private var state: ORTValue
    private var context = [Float](repeating: 0, count: 64)

    init(model: URL) throws {
      environment = try ORTEnv(loggingLevel: .warning)
      let options = try ORTSessionOptions()
      try options.setIntraOpNumThreads(1)
      session = try ORTSession(env: environment, modelPath: model.path, sessionOptions: options)
      sampleRate = try Self.tensor([Int64(16_000)], type: .int64, shape: [1])
      state = try Self.tensor([Float](repeating: 0, count: 256), type: .float, shape: [2, 1, 128])
    }

    func probability(_ frame: [Float]) throws -> Float {
      // Match vad-web 0.0.31's 64-sample context window, including zero padding
      // of the last partial frame. State resets for every new-audio analysis.
      let input = context + frame
      let result = try session.run(
        withInputs: [
          "input": Self.tensor(input, type: .float, shape: [1, NSNumber(value: input.count)]),
          "state": state,
          "sr": sampleRate,
        ], outputNames: ["output", "stateN"], runOptions: nil)
      guard let output = result["output"], let nextState = result["stateN"] else {
        throw DetectionError.invalidOutput
      }
      let bytes = try output.tensorData() as Data
      guard bytes.count == MemoryLayout<Float>.size else { throw DetectionError.invalidOutput }
      state = nextState
      context = Array(frame.suffix(64))
      return bytes.withUnsafeBytes { $0.loadUnaligned(as: Float.self) }
    }

    private static func tensor<T>(
      _ values: [T], type: ORTTensorElementDataType, shape: [NSNumber]
    ) throws -> ORTValue {
      let bytes = values.withUnsafeBufferPointer { Data(buffer: $0) }
      return try ORTValue(tensorData: NSMutableData(data: bytes), elementType: type, shape: shape)
    }
  }
}
