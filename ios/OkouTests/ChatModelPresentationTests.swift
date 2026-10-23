import ChatData
import ChatDataTestSupport
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatModelPresentationTests: XCTestCase {
  func testNativeModelSheetRemainsPresentedAcrossModelEffortAndFastChanges() async throws {
    let fixture = ChatHTTPFixture { request in
      try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    let host = UIHostingController(rootView: ModelSheetHarness(selection: selection))
    let window = try await mountModelHost(host)
    defer { unmount(window) }
    try await eventually { host.presentedViewController != nil }
    let sheet = try XCTUnwrap(host.presentedViewController)
    await selection.choose(model: "claude-model")
    await selection.choose(effort: "max")
    await selection.choose(model: "codex-model")
    await selection.choose(effort: "xhigh")
    await selection.setFast(true)
    XCTAssertTrue(host.presentedViewController === sheet)
    XCTAssertEqual(selection.effectiveEffort, "xhigh")
    XCTAssertEqual(selection.selection.modelSettings["claude-model"]?.effort, "max")
    XCTAssertEqual(selection.selection.serviceTier, "priority")
    try await screenshot(window, name: "Model sheet light after changes")
    let expanded = UIHostingController(
      rootView: ChatModelPickerView(selection: selection).modifier(OkouAppearance()))
    window.rootViewController = expanded
    try await screenshot(window, name: "Model controls light Fast and effort")
  }

  func testFastSwitchKeepsItsThumbVisibleWithAppThemeAcrossAppearancesAndStates() async throws {
    let fixture = ChatHTTPFixture { request in
      try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    let host = UIHostingController(
      rootView: ChatModelPickerView(selection: selection)
        .modifier(OkouAppearance()).disabled(false))
    let window = try await mountModelHost(host)
    defer { unmount(window) }
    // Keep the same mounted page while switching the system appearance in both directions.
    for style in [UIUserInterfaceStyle.light, .dark, .light] {
      window.overrideUserInterfaceStyle = style
      for fast in [false, true] {
        await selection.setFast(fast)
        for disabled in [false, true] {
          host.rootView = ChatModelPickerView(selection: selection)
            .modifier(OkouAppearance()).disabled(disabled)
          try await eventually {
            guard let control = self.fastSwitch(in: host.view) else { return false }
            return control.isOn == fast && control.isEnabled == !disabled
              && control.traitCollection.userInterfaceStyle == style
          }
          let control = try XCTUnwrap(fastSwitch(in: host.view))
          let image = await captureAppearance(
            window, name: "Fast switch \(style) on=\(fast) disabled=\(disabled)")
          let frame = control.convert(control.bounds, to: window)
          XCTAssertTrue(window.bounds.contains(frame), "The Fast switch must be on screen")
          if fast && !disabled {
            // Sample only the capsule's center strip: outside corners must not stand
            // in for the missing contrast between the thumb and the on-state track.
            let interior = control.bounds.insetBy(
              dx: control.bounds.width * 0.2, dy: control.bounds.height * 0.4)
            let region = control.convert(interior, to: window)
              .applying(CGAffineTransform(scaleX: image.scale, y: image.scale))
            let contrast = try renderedContrast(try XCTUnwrap(image.cgImage), in: region)
            XCTAssertGreaterThan(contrast, 1.5, "The on-state thumb disappears in \(style)")
          }
        }
      }
    }
  }

  func testNativeModelsAndSubscriptionsInDarkChineseAndLargeText() async throws {
    let fixture = ChatHTTPFixture { request in
      try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
    }
    let resource = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: resource)
    defer {
      resource.close()
      selection.close()
    }
    await selection.open()
    await resource.subscriptions.refresh()
    let host = UIHostingController(
      rootView: ChatModelPickerView(selection: selection)
        .modifier(OkouAppearance())
        .environment(\.locale, Locale(identifier: "zh-Hans"))
        .environment(\.dynamicTypeSize, .accessibility2)
        .preferredColorScheme(.dark))
    let window = try await mountModelHost(host)
    defer { unmount(window) }
    try await screenshot(window, name: "Models dark Chinese accessibility text")
    let accounts = UIHostingController(
      rootView: NavigationStack {
        PersonalSubscriptionsView(store: resource.subscriptions)
      }.modifier(OkouAppearance())
        .environment(\.locale, Locale(identifier: "zh-Hans")).preferredColorScheme(.dark))
    window.rootViewController = accounts
    accounts.view.layoutIfNeeded()
    try await screenshot(window, name: "Subscriptions dark Chinese")
  }

  func testNativeCodexAndClaudeAuthorizationStepsUseSyntheticSessions() async throws {
    let cancellations = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/sessions") {
        let codex = request.url!.path.contains("/codex/")
        return ChatHTTPResponse(
          body:
            "{\"sessionToken\":\"synthetic-session\",\"browserUrl\":\"https://auth.example.invalid/authorize\",\"expiresIn\":300,\"interval\":300\(codex ? ",\"verificationCode\":\"EXAMPLE-CODE\"" : "")}"
        )
      }
      if request.url!.path.hasSuffix("/cancel") {
        cancellations.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{\"status\":\"cancelled\"}")
      }
      throw URLError(.unsupportedURL)
    }
    let store = PersonalSubscriptionStore(client: fixture.client, didFail: { _ in })
    defer { store.close() }
    store.start(type: .codex)
    try await eventually { store.phase == .pending }
    let host = UIHostingController(rootView: SubscriptionAuthorizationView(store: store))
    let window = try await mountModelHost(host)
    defer { unmount(window) }
    try await screenshot(window, name: "Codex authorization example")
    store.start(type: .claude)
    try await eventually { store.phase == .pending && store.verificationCode == nil }
    try await screenshot(window, name: "Claude authorization example")
    store.cancelAuth()
    try await eventually { cancellations.withLock { $0 } == 2 }
  }

  private func mountModelHost<V: View>(_ host: UIHostingController<V>) async throws -> UIWindow {
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    host.view.layoutIfNeeded()
    await Task.yield()
    return window
  }

  private func fastSwitch(in view: UIView) -> UISwitch? {
    if let control = view as? UISwitch, control.window != nil { return control }
    return view.subviews.lazy.compactMap { self.fastSwitch(in: $0) }.first
  }

  private func screenshot(_ window: UIWindow, name: String) async throws {
    // Wait for native presentation/layout, then keep a reviewable simulator artifact.
    for _ in 0..<3 {
      await Task.yield()
      window.layoutIfNeeded()
    }
    try await Task.sleep(for: .milliseconds(200))
    let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: image)
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}

private struct ModelSheetHarness: View {
  let selection: ChatModelSelectionStore
  @State private var presented = true
  var body: some View {
    ChatModelPickerButton(selection: selection)
      .modifier(OkouAppearance())
      .sheet(isPresented: $presented) {
        ChatModelPickerView(selection: selection)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
      }
  }
}
