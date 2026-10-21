import ChatDataTestSupport
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatModelEntryTests: XCTestCase {
  func testColdComposerLoadsModelSettingsWithoutPreloadingOrReplacingTheEditor() async throws {
    let requested = expectation(description: "Mounted composer requests model settings")
    requested.expectedFulfillmentCount = 4
    let delivered = expectation(description: "Model settings responses delivered")
    delivered.expectedFulfillmentCount = 4
    let (responses, response) = AsyncStream<Void>.makeStream()
    defer { response.finish() }
    let fixture = ChatHTTPFixture { request in
      requested.fulfill()
      if request.url?.path == "/api/run-models" {
        for await _ in responses { break }
      }
      let result = try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      delivered.fulfill()
      return result
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    let host = UIHostingController(rootView: ModelEntryComposer(workspace: workspace))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    host.view.layoutIfNeeded()
    try await eventually { self.textView(in: host.view)?.bounds.isEmpty == false }
    await fulfillment(of: [requested], timeout: 3)
    let input = try XCTUnwrap(textView(in: host.view))
    input.becomeFirstResponder()
    input.insertText("Keep this draft while models load")
    let selection = NSRange(location: 5, length: 4)
    input.selectedRange = selection
    try await eventually {
      input.isFirstResponder && input.bounds.height >= (input.font?.lineHeight ?? 20) * 2 - 1
    }
    response.yield()
    await fulfillment(of: [delivered], timeout: 3)
    await hostingPresentationFrame()
    await hostingPresentationFrame()
    XCTAssertTrue(textView(in: host.view) === input)
    XCTAssertTrue(input.isFirstResponder)
    XCTAssertEqual(input.text, "Keep this draft while models load")
    XCTAssertEqual(input.selectedRange, selection)
  }

  private func textView(in view: UIView) -> ComposerTextView? {
    if let input = view as? ComposerTextView { return input }
    return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
  }
}

private struct ModelEntryComposer: View {
  let workspace: WorkspaceStore
  var body: some View {
    @Bindable var composer = workspace.newComposer
    VStack {
      Spacer()
      ChatComposerView(
        draft: $composer.text, isBusy: false, showsProgress: false, canStop: false,
        needsUpgrade: false, error: nil, attachmentURL: workspace.webURL,
        attachments: composer.attachments, draftState: composer,
        submit: {}, refresh: nil, modelSelection: workspace.newModelSelection)
    }
  }
}
