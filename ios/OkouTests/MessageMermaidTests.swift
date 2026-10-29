import UIKit
import XCTest

@testable import Okou

@MainActor
final class MessageMermaidTests: XCTestCase {
  func testNativeRendererProducesDecodableChineseFlowchartAndSequenceImages() async throws {
    let renderer = MessageMermaidRenderer()
    for source in [
      "flowchart TD\n A[用户操作卡片] --> B[保存反馈]\n B --> C[更新首页卡片]",
      "sequenceDiagram\n participant User\n participant Okou\n User->>Okou: Save feedback\n Okou-->>User: Saved",
    ] {
      let data = try await renderer.image(for: source, dark: false)
      XCTAssertNotNil(UIImage(data: try XCTUnwrap(data)))
    }
  }

  func testUnsupportedAndOversizedDiagramsDoNotProduceMisleadingImages() async throws {
    let renderer = MessageMermaidRenderer()
    do {
      _ = try await renderer.image(for: "not-a-diagram\n A --> B", dark: false)
      XCTFail("An unsupported diagram must retain its source instead of showing an empty image")
    } catch is CancellationError {
      throw CancellationError()
    } catch {}
    let oversized = "flowchart TD\n" + String(repeating: "A --> B\n", count: 501)
    let image = try await renderer.image(for: oversized, dark: false)
    XCTAssertNil(image)
  }

  func testCancelledRenderDoesNotPublishAnImage() async throws {
    let renderer = MessageMermaidRenderer()
    let task = Task {
      try await renderer.image(for: "flowchart TD\n A --> B", dark: true)
    }
    task.cancel()
    do {
      _ = try await task.value
      XCTFail("A cancelled message must not publish its diagram")
    } catch is CancellationError {
    }
  }
}
