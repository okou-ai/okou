import ChatDataTestSupport
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ChatModelEntryTests: XCTestCase {
  func testColdComposerLoadsModelSettingsWithoutPreloadingOrReplacingTheEditor() async throws {
    let requested = expectation(description: "Mounted composer requests model settings")
    let delivered = expectation(description: "Model settings responses delivered")
    let (responses, response) = AsyncStream<Void>.makeStream()
    defer { response.finish() }
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/run-models" {
        requested.fulfill()
        for await _ in responses { break }
        delivered.fulfill()
      }
      let result = try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      return result
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    let host = UIHostingController(rootView: ModelEntryComposer(workspace: workspace))
    configureNativeHostAnimations(for: self)
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    host.view.layoutIfNeeded()
    try await eventually { self.textView(in: host.view)?.window === window }
    await fulfillment(of: [requested], timeout: 3)
    let input = try XCTUnwrap(textView(in: host.view))
    try await focusMentionInput(input)
    input.insertText("Keep this draft while models load")
    let selection = NSRange(location: 5, length: 4)
    input.selectedRange = selection
    response.yield()
    await fulfillment(of: [delivered], timeout: 3)
    await hostingPresentationFrame()
    await hostingPresentationFrame()
    let current = try XCTUnwrap(textView(in: host.view))
    XCTAssertTrue(current.isFirstResponder)
    XCTAssertEqual(current.text, "Keep this draft while models load")
    XCTAssertEqual(current.selectedRange, selection)
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
