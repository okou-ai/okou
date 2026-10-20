import SwiftUI

/// A native circular glass control; only non-pin operations and workspace blocking disable it.
struct ChatThreadPinButton: View {
  let list: ThreadListStore
  let threadID: String
  let needsUpgrade: Bool

  var body: some View {
    if let thread = list.threads.first(where: { $0.id == threadID }) {
      ChatThreadPinControl(
        pinned: thread.pinnedAt != nil,
        enabled: !needsUpgrade && list.canPin(threadID)
      ) {
        // Read the current projection on activation, including clicks before the next render.
        Task { await list.togglePinned(threadID) }
      }
      .frame(width: 48, height: 48)
    }
  }
}

private struct ChatThreadPinControl: UIViewRepresentable {
  let pinned: Bool
  let enabled: Bool
  let activate: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .system)
    var configuration = UIButton.Configuration.glass()
    configuration.cornerStyle = .capsule
    configuration.contentInsets = .zero
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
      pointSize: 19, weight: .medium)
    button.configuration = configuration
    button.accessibilityIdentifier = "toggle-chat-pin"
    button.addAction(
      UIAction { [coordinator = context.coordinator] _ in coordinator.activate() },
      for: .touchUpInside)
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    context.coordinator.activate = activate
    button.configuration?.image = UIImage(systemName: pinned ? "pin.fill" : "pin")
    button.tintColor = .label
    button.isEnabled = enabled
    button.accessibilityLabel = pinned ? "Unpin chat" : "Pin chat"
    button.accessibilityValue = pinned ? "Pinned" : "Not pinned"
  }

  final class Coordinator {
    var activate: () -> Void = {}
  }
}
