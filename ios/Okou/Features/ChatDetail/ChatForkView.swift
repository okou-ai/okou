import ChatData
import ChatDomain
import SwiftUI
import UIKit

struct ChatForkView: View {
  @Bindable var flow: ChatForkStore
  let webURL: URL
  let threads: [ChatThread]
  let project: ChatProject?
  let needsUpgrade: Bool
  let dismiss: () -> Void
  @State private var confirmsDiscard = false
  @State private var contentHeight: CGFloat = 0
  @State private var navigationInset: CGFloat = 0
  /// The sheet, not workspace navigation, decides when its editor may take focus.
  @State private var presentation = WorkspaceChatPresentation()

  /// Up to this fitted height the sheet clears the keyboard below the largest detent.
  private static let keyboardClearHeight: CGFloat = 340

  private var fittedHeight: CGFloat {
    contentHeight > 0 && navigationInset > 0 ? contentHeight + navigationInset : 0
  }
  private var fittedDetent: PresentationDetent {
    fittedHeight > 0 ? .height(fittedHeight) : .medium
  }
  /// UIKit lifts a fitted sheet above the keyboard. Repeating that inset in SwiftUI moved
  /// the draft against its title during every keyboard transition. A taller draft can reach
  /// the largest detent, so it keeps SwiftUI's inset and its controls stay reachable.
  private var ignoredSafeArea: SafeAreaRegions {
    fittedHeight > 0 && fittedHeight <= Self.keyboardClearHeight ? .keyboard : []
  }

  private func requestDismiss() {
    guard !flow.isSending else { return }
    if flow.hasEdits { confirmsDiscard = true } else { dismiss() }
  }

  private func finishPresenting(nativeInset: CGFloat) {
    // The native bar is the fallback when SwiftUI reported no inset while presenting.
    if navigationInset == 0, nativeInset > 0 { navigationInset = nativeInset }
    presentation.appear()
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        if let error = flow.error {
          OkouBanner(Text(error), icon: "circle-alert", tone: .problem) {
            Button("Retry") { Task { await flow.send() } }
              .disabled(flow.isSending || needsUpgrade)
          }
          .accessibilityIdentifier("fork-send-error")
          .padding(.horizontal, OkouControl.pageInset)
        }
        @Bindable var composer = flow.composer
        ChatComposerView(
          draft: $composer.text, isBusy: flow.isSending, showsProgress: flow.isSending,
          canStop: false, needsUpgrade: needsUpgrade, error: nil,
          attachmentURL: webURL, attachments: composer.attachments, draftState: composer,
          submit: { await flow.send() }, refresh: nil,
          modelSelection: flow.modelSelection,
          connectorSelection: flow.modelSelection.connectors,
          mentionSource: ComposerMentionSource(agentID: flow.agentID, threads: threads),
          workflowSource: flow.workflowSource, agentID: flow.agentID,
          showsTrailingFeedbackInput: false, project: project
        )
        // A failed or unknown attempt retries the captured message, never an edited body
        // under the same idempotency key. The error banner owns the explicit retry.
        .disabled(flow.hasPendingAttempt || needsUpgrade)
      }
      .fixedSize(horizontal: false, vertical: true)
      // Measure intrinsic content separately from the native navigation container.
      .onGeometryChange(for: CGFloat.self) { geometry in
        ceil(geometry.size.height)
      } action: { height in
        contentHeight = height
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      // The first layout already has the bar's inset, before the sheet starts presenting.
      .onGeometryChange(for: CGFloat.self) { geometry in
        ceil(geometry.safeAreaInsets.top)
      } action: { inset in
        if inset > 0 { navigationInset = inset }
      }
      .ignoresSafeArea(ignoredSafeArea, edges: .bottom)
      .environment(\.workspaceChatPresentation, presentation)
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem(action: requestDismiss)
      }
      .background(OkouColor.background)
      .confirmationDialog(
        "Discard draft?", isPresented: $confirmsDiscard, titleVisibility: .visible
      ) {
        Button("Discard", role: .destructive, action: dismiss)
        Button("Keep editing", role: .cancel) {}
      } message: {
        if flow.deliveryUnconfirmed {
          Text("Delivery hasn’t been confirmed. Closing this sheet won’t cancel the message.")
        } else {
          Text("Your message hasn’t been sent.")
        }
      }
    }
    .interactiveDismissDisabled(flow.isSending || flow.hasEdits)
    .background {
      ForkDismissObserver(onAttempt: requestDismiss, onPresented: finishPresenting)
    }
    .task(id: fittedHeight) {
      // A keyboard that opens before the fitted height settles resizes the sheet again
      // while it is still presenting, so native focus waits for a stable measurement.
      guard fittedHeight > 0, !presentation.allowsFocus else { return }
      do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
      guard !Task.isCancelled else { return }
      presentation.appear()
    }
    .presentationDetents([fittedDetent], selection: .constant(fittedDetent))
    .presentationContentInteraction(.scrolls)
    .presentationDragIndicator(.visible)
    .okouSheetBackground(OkouColor.background)
    .accessibilityIdentifier("fork-sheet")
  }
}

/// Observe a blocked native swipe while preserving SwiftUI's presentation delegate.
private struct ForkDismissObserver: UIViewControllerRepresentable {
  let onAttempt: () -> Void
  /// Reports the native bar's bottom edge once the sheet has finished presenting.
  let onPresented: (CGFloat) -> Void

  func makeUIViewController(context: Context) -> Observer {
    Observer(onAttempt: onAttempt, onPresented: onPresented)
  }

  func updateUIViewController(_ controller: Observer, context: Context) {
    controller.onAttempt = onAttempt
    controller.onPresented = onPresented
  }

  final class Observer: UIViewController, UIAdaptivePresentationControllerDelegate {
    var onAttempt: () -> Void
    var onPresented: (CGFloat) -> Void
    private weak var previous: (any UIAdaptivePresentationControllerDelegate)?
    private weak var observed: UIPresentationController?

    init(onAttempt: @escaping () -> Void, onPresented: @escaping (CGFloat) -> Void) {
      self.onAttempt = onAttempt
      self.onPresented = onPresented
      super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      var host: UIViewController? = self
      while let parent = host?.parent { host = parent }
      var inset: CGFloat = 0
      if let host, let navigation = Self.findNavigationController(in: host) {
        inset = navigation.navigationBar.convert(navigation.navigationBar.bounds, to: host.view)
          .maxY
      }
      onPresented(ceil(max(0, inset)))
      guard let presentation = host?.presentationController,
        presentation.delegate !== self
      else { return }
      previous = presentation.delegate
      observed = presentation
      presentation.delegate = self
    }

    private static func findNavigationController(in controller: UIViewController)
      -> UINavigationController?
    {
      if let navigation = controller as? UINavigationController { return navigation }
      for child in controller.children {
        if let navigation = findNavigationController(in: child) { return navigation }
      }
      return nil
    }

    override func viewDidDisappear(_ animated: Bool) {
      super.viewDidDisappear(animated)
      if observed?.delegate === self { observed?.delegate = previous }
    }

    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController)
      -> Bool
    {
      previous?.presentationControllerShouldDismiss?(presentationController) ?? true
    }

    func presentationControllerWillDismiss(_ presentationController: UIPresentationController) {
      previous?.presentationControllerWillDismiss?(presentationController)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
      previous?.presentationControllerDidDismiss?(presentationController)
    }

    func presentationControllerDidAttemptToDismiss(
      _ presentationController: UIPresentationController
    ) {
      previous?.presentationControllerDidAttemptToDismiss?(presentationController)
      onAttempt()
    }
  }
}
