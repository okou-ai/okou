import UIKit
import Vision
import XCTest

@MainActor
extension XCTestCase {
  func captureAppearance(_ window: UIWindow, name: String) async -> UIImage {
    window.layoutIfNeeded()
    await hostingPresentationFrame()
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
    return image
  }
}

func renderedContrast(_ image: CGImage, in bounds: CGRect) throws -> Double {
  let crop = try XCTUnwrap(image.cropping(to: bounds.integral))
  let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
  var pixels = [UInt8](repeating: 0, count: crop.width * crop.height * 4)
  try pixels.withUnsafeMutableBytes { buffer in
    let context = try XCTUnwrap(
      CGContext(
        data: buffer.baseAddress, width: crop.width, height: crop.height,
        bitsPerComponent: 8, bytesPerRow: crop.width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
          | CGBitmapInfo.byteOrder32Big.rawValue))
    context.draw(
      crop, in: CGRect(x: 0, y: 0, width: CGFloat(crop.width), height: CGFloat(crop.height)))
  }
  func linear(_ value: UInt8) -> Double {
    let channel = Double(value) / 255
    return channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
  }
  let luminances = stride(from: 0, to: pixels.count, by: 4).map { offset in
    0.2126 * linear(pixels[offset]) + 0.7152 * linear(pixels[offset + 1])
      + 0.0722 * linear(pixels[offset + 2])
  }.sorted()
  // Ignore antialiasing extremes while measuring actual foreground and background pixels.
  let low = luminances[(luminances.count - 1) / 20]
  let high = luminances[(luminances.count - 1) * 19 / 20]
  return (high + 0.05) / (low + 0.05)
}

func recognizedTextBounds(_ text: String, in image: CGImage) async throws -> CGRect {
  let (normalized, lines) = try await Task.detached { () -> (CGRect?, [String]) in
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    var lines: [String] = []
    for observation in request.results ?? [] {
      guard let candidate = observation.topCandidates(1).first else { continue }
      lines.append(candidate.string)
      if let range = candidate.string.range(of: text),
        let match = try candidate.boundingBox(for: range)
      {
        return (match.boundingBox, lines)
      }
    }
    return (nil, lines)
  }.value
  let bounds = try XCTUnwrap(normalized, "Expected visible \(text); recognized: \(lines)")
  return CGRect(
    x: bounds.minX * CGFloat(image.width), y: (1 - bounds.maxY) * CGFloat(image.height),
    width: bounds.width * CGFloat(image.width), height: bounds.height * CGFloat(image.height))
}
