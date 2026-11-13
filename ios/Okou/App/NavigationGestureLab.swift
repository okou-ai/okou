#if DEBUG || STAGING
  import ChatDomain
  import Observation
  import SwiftUI
  import UIKit

  /// Disposable, on-demand experiment using the production navigation and transcript adapters.
  struct NavigationGestureLab: View {
    @State private var sidebar = SidebarInteraction()
    @State private var probe = NavigationGestureLabProbe()
    @State private var fixture = NavigationGestureLabFixture()
    @State private var draft = ""

    var body: some View {
      WorkspaceNavigation(
        sidebar: sidebar,
        list: {
          VStack(spacing: 24) {
            Text(verbatim: "Gesture lab sidebar").accessibilityIdentifier("lab-sidebar")
            Text(verbatim: probe.policy)
            Button("Open chat") { sidebar.setOpen(false) }
              .accessibilityIdentifier("lab-open-chat")
            log
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(OkouColor.background)
        },
        chat: {
          VStack(spacing: 0) {
            HStack {
              Button("Chats") { sidebar.setOpen(true) }
                .accessibilityIdentifier("lab-open-sidebar")
              Spacer()
              Text(verbatim: probe.policy).font(.caption)
            }
            .padding()
            .background(OkouColor.background)
            ConversationCollectionView(
              rows: fixture.rows, markdown: fixture.markdown,
              renderContext: { _ in
                MessageRenderPlan.Context(
                  webURL: fixture.baseURL, action: nil, permissionsEnabled: false, artifacts: nil)
              },
              anchor: fixture.anchor, scroll: fixture.scroll, followsBottom: false,
              phaseChanged: { probe.record("phase \(String(describing: $0))") },
              metricsChanged: { _ in }, rowsPresented: { _ in }, refresh: {}
            ) { row, _ in
              if let message = row.message {
                MessageBodyView(
                  text: message.text, baseURL: fixture.baseURL, markdown: fixture.markdown
                )
                .padding(20)
              }
            }
            .accessibilityIdentifier("lab-transcript")
            TextField("Unsent draft", text: $draft)
              .textFieldStyle(.roundedBorder)
              .padding(.horizontal)
              .accessibilityIdentifier("lab-draft")
            log
          }
          .background(OkouColor.background)
        }, gestureLab: probe
      )
      .onChange(of: sidebar.isOpen) { _, open in probe.record("sidebar \(open)") }
      .onChange(of: sidebar.isTransitioning) { _, active in probe.record("transition \(active)") }
    }

    private var log: some View {
      Text(verbatim: probe.events.suffix(5).joined(separator: "\n"))
        .font(.system(size: 9, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .accessibilityIdentifier("lab-log")
    }
  }

  @MainActor
  private final class NavigationGestureLabFixture {
    let baseURL = URL(string: "https://staging-app-okou-app-preview.vm0.workers.dev")!
    let markdown: MessageMarkdownCache
    let anchor = ConversationScrollAnchor()
    let scroll = ConversationCollectionScroll()
    let rows: [ConversationCollectionRow]

    init() {
      markdown = MessageMarkdownCache(baseURL: baseURL)
      rows = (1...80).map { index in
        let text = """
          ## Paragraph \(index)

          This is a static conversation fixture for native navigation. Fling the transcript, then immediately swipe right before deceleration ends. The same production collection, Markdown renderer, and navigation container are used in every policy.

          Keep scrolling, cancellation, keyboard dismissal, and unsent drafts working.
          """
        let message = ChatMessage(
          id: "lab-\(index)", role: .assistant, text: text,
          createdAt: Date(timeIntervalSince1970: Double(index)), runID: nil,
          isQueued: false, isError: false)
        return .message(
          message, showsAvatar: false, topSpacing: 24, pendingRetry: nil, isSending: false)
      }
    }
  }

  @MainActor @Observable
  final class NavigationGestureLabProbe: NSObject {
    let policy: String
    private(set) var events: [String] = []
    @ObservationIgnored private weak var navigation: UINavigationController?
    @ObservationIgnored private var proxies: [NavigationGestureLabDelegate] = []
    @ObservationIgnored private let started = CACurrentMediaTime()

    override init() {
      policy = ProcessInfo.processInfo.environment["OKOU_GESTURE_LAB_POLICY"] ?? "baseline"
      super.init()
    }

    static func fromEnvironment() -> NavigationGestureLabProbe? {
      guard ProcessInfo.processInfo.environment["OKOU_GESTURE_LAB_POLICY"] != nil else {
        return nil
      }
      return NavigationGestureLabProbe()
    }

    func record(_ event: String) {
      let line = String(format: "%.3f %@", CACurrentMediaTime() - started, event)
      events.append(line)
      if events.count > 150 { events.removeFirst(events.count - 150) }
      NSLog("GESTURE_LAB %@ %@", policy, line)
    }

    func install(on navigation: UINavigationController) {
      self.navigation = navigation
      if policy == "native-visible" { navigation.setNavigationBarHidden(false, animated: false) }
      let recognizers = [
        navigation.interactivePopGestureRecognizer,
        navigation.interactiveContentPopGestureRecognizer,
      ].compactMap { $0 }
      for (index, recognizer) in recognizers.enumerated() {
        let original = recognizer.delegate
        let originalName = original.map { String(describing: type(of: $0)) } ?? "nil"
        record("install \(index) original=\(originalName)")
        if policy == "baseline" {
          recognizer.delegate = nil
        } else if [
          "proxy", "proxy-simultaneous", "minimal-simultaneous", "direction-simultaneous",
          "direction-priority",
        ].contains(policy) {
          let proxy = NavigationGestureLabDelegate(
            navigation: navigation, original: policy == "minimal-simultaneous" ? nil : original,
            probe: self,
            simultaneous: ["proxy-simultaneous", "minimal-simultaneous", "direction-simultaneous"]
              .contains(policy),
            direction: policy.hasPrefix("direction-"), priority: policy == "direction-priority")
          proxies.append(proxy)
          recognizer.delegate = proxy
        }
        recognizer.addTarget(self, action: #selector(gestureChanged(_:)))
      }
    }

    @objc private func gestureChanged(_ recognizer: UIGestureRecognizer) {
      let kind = recognizer === navigation?.interactivePopGestureRecognizer ? "edge" : "content"
      guard recognizer.state != .changed else { return }
      record("\(kind) state=\(recognizer.state.rawValue) \(scrollStatus())")
    }

    func scrollStatus() -> String {
      guard let root = navigation?.view else { return "no view" }
      func find(_ view: UIView) -> UIScrollView? {
        if let collection = view as? UICollectionView { return collection }
        for child in view.subviews { if let result = find(child) { return result } }
        return nil
      }
      guard let scroll = find(root) else { return "no collection" }
      return "decel=\(scroll.isDecelerating) drag=\(scroll.isDragging)"
        + " pan=\(scroll.panGestureRecognizer.state.rawValue) y=\(Int(scroll.contentOffset.y))"
    }
  }

  @MainActor
  private final class NavigationGestureLabDelegate: NSObject, UIGestureRecognizerDelegate {
    private weak var navigation: UINavigationController?
    private let original: (any UIGestureRecognizerDelegate)?
    private weak var probe: NavigationGestureLabProbe?
    private let simultaneous: Bool
    private let direction: Bool
    private let priority: Bool

    init(
      navigation: UINavigationController, original: (any UIGestureRecognizerDelegate)?,
      probe: NavigationGestureLabProbe, simultaneous: Bool, direction: Bool, priority: Bool
    ) {
      self.navigation = navigation
      self.original = original
      self.probe = probe
      self.simultaneous = simultaneous
      self.direction = direction
      self.priority = priority
      super.init()
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      var allowed =
        (navigation?.viewControllers.count ?? 0) > 1
        && navigation?.transitionCoordinator == nil
      if direction, let pan = gestureRecognizer as? UIPanGestureRecognizer {
        let velocity = pan.velocity(in: navigation?.view)
        let x = navigation?.view.effectiveUserInterfaceLayoutDirection == .rightToLeft
          ? -velocity.x : velocity.x
        allowed = allowed && x > abs(velocity.y)
      }
      probe?.record("shouldBegin=\(allowed) \(probe?.scrollStatus() ?? "")")
      return allowed
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      let native =
        original?.gestureRecognizer?(
          gestureRecognizer, shouldRecognizeSimultaneouslyWith: otherGestureRecognizer) ?? false
      guard simultaneous, let scroll = otherGestureRecognizer.view as? UIScrollView,
        otherGestureRecognizer === scroll.panGestureRecognizer,
        scroll.contentSize.width <= scroll.bounds.width + 1
      else { return native }
      probe?.record("simultaneous vertical \(probe?.scrollStatus() ?? "")")
      return true
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch
    ) -> Bool {
      original?.gestureRecognizer?(gestureRecognizer, shouldReceive: touch) ?? true
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer, shouldReceive press: UIPress
    ) -> Bool {
      original?.gestureRecognizer?(gestureRecognizer, shouldReceive: press) ?? true
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer, shouldReceive event: UIEvent
    ) -> Bool {
      original?.gestureRecognizer?(gestureRecognizer, shouldReceive: event) ?? true
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      original?.gestureRecognizer?(
        gestureRecognizer, shouldRequireFailureOf: otherGestureRecognizer) ?? false
    }

    func gestureRecognizer(
      _ gestureRecognizer: UIGestureRecognizer,
      shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
      if priority, let scroll = otherGestureRecognizer.view as? UIScrollView,
        otherGestureRecognizer === scroll.panGestureRecognizer,
        scroll.contentSize.width <= scroll.bounds.width + 1
      {
        probe?.record("navigation priority \(probe?.scrollStatus() ?? "")")
        return true
      }
      return original?.gestureRecognizer?(
        gestureRecognizer, shouldBeRequiredToFailBy: otherGestureRecognizer) ?? false
    }
  }
#endif
