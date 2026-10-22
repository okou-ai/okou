import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

actor ArtifactVideoPoster {
  static let shared = ArtifactVideoPoster()

  func thumbnail(_ url: URL) async throws -> Data? {
    // Only the authority's temporary content address reaches AVFoundation. No API headers,
    // shared cookies or native bridge are supplied, and cancellation stops frame generation.
    let request = VideoPosterRequest(url)
    let result = try await withTaskCancellationHandler {
      try await request.generator.image(at: CMTime(seconds: 0, preferredTimescale: 600))
    } onCancel: {
      request.generator.cancelAllCGImageGeneration()
    }
    try Task.checkCancellation()
    let data = NSMutableData()
    guard
      let destination = CGImageDestinationCreateWithData(
        data, UTType.jpeg.identifier as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, result.image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }
}

// Configuration is finished before publication. AVFoundation permits concurrent cancellation
// of its asynchronous image generation; no other mutable state crosses executors.
private final class VideoPosterRequest: @unchecked Sendable {
  let generator: AVAssetImageGenerator
  init(_ url: URL) {
    let asset = AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: [HTTPCookie]()])
    generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 800, height: 800)
  }
}
