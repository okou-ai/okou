import ChatDomain
import SwiftUI
import UIKit

struct ChatForkView: View {
  @Bindable var flow: ChatForkStore
  let webURL: URL
  let threads: [ChatThread]
  let needsUpgrade: Bool
  let dismiss: () -> Void
  @State private var confirmsDiscard = false

  private func requestDismiss() {
    guard !flow.isSending else { return }
    if flow.hasEdits { confirmsDiscard = true } else { dismiss() }
  }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: OkouSpace.lg) {
        Text("Continue from this passage.")
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        Spacer(minLength: 0)
        if flow.hasSourceQuote {
          Label {
            Text("From \(flow.sourceTitle)").lineLimit(1)
          } icon: {
            OkouIcon("git-branch", size: OkouIconSize.reference)
          }
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          .accessibilityIdentifier("fork-source")
        }
        if let error = flow.error {
          OkouBanner(Text(error), icon: "circle-alert", tone: .problem) {
            Button("Retry") { Task { await flow.send() } }
              .disabled(flow.isSending || needsUpgrade)
          }
          .accessibilityIdentifier("fork-send-error")
        }
      }
      .padding(.horizontal, OkouControl.pageInset)
      .padding(.top, OkouSpace.lg)
      .padding(.bottom, OkouSpace.sm)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        @Bindable var composer = flow.composer
        ChatComposerView(
          draft: $composer.text, isBusy: flow.isSending, showsProgress: flow.isSending,
          canStop: false, needsUpgrade: needsUpgrade, error: nil,
          attachmentURL: webURL, attachments: composer.attachments, draftState: composer,
          submit: { await flow.send() }, refresh: nil,
          modelSelection: flow.modelSelection,
          connectorSelection: flow.modelSelection.connectors,
          mentionSource: ComposerMentionSource(agentID: flow.agentID, threads: threads),
          workflowSource: flow.workflowSource, agentID: flow.agentID
        )
        // A failed or unknown attempt retries the captured message, never an edited body
        // under the same idempotency key. The error banner owns the explicit retry.
        .disabled(flow.hasPendingAttempt || needsUpgrade)
      }
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
      ForkDismissObserver(onAttempt: requestDismiss)
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(OkouColor.background)
    .accessibilityIdentifier("fork-sheet")
  }
}

/// Observe a blocked native swipe while preserving SwiftUI's presentation delegate.
private struct ForkDismissObserver: UIViewControllerRepresentable {
  let onAttempt: () -> Void

  func makeUIViewController(context: Context) -> Observer { Observer(onAttempt: onAttempt) }

  func updateUIViewController(_ controller: Observer, context: Context) {
    controller.onAttempt = onAttempt
  }

  final class Observer: UIViewController, UIAdaptivePresentationControllerDelegate {
    var onAttempt: () -> Void
    private weak var previous: (any UIAdaptivePresentationControllerDelegate)?
    private weak var observed: UIPresentationController?

    init(onAttempt: @escaping () -> Void) {
      self.onAttempt = onAttempt
      super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { return nil }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      var host: UIViewController? = self
      while let parent = host?.parent { host = parent }
      guard let presentation = host?.presentationController,
        presentation.delegate !== self
      else { return }
      previous = presentation.delegate
      observed = presentation
      presentation.delegate = self
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
