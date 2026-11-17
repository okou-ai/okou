import SwiftUI

/// The first-history skeleton belongs to the native control, including its delayed reveal.
@MainActor
final class ConversationLoading {
  private let host = UIHostingController(rootView: OkouChatSkeleton())
  private let sleep: @MainActor (Duration) async throws -> Void
  private let needsLoading: @MainActor () -> Bool
  private var task: Task<Void, Never>?

  init(
    sleep: @escaping @MainActor (Duration) async throws -> Void,
    needsLoading: @escaping @MainActor () -> Bool
  ) {
    self.sleep = sleep
    self.needsLoading = needsLoading
  }

  func install(in parent: UIViewController) {
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    host.view.isHidden = true
    parent.addChild(host)
    parent.view.addSubview(host.view)
    host.didMove(toParent: parent)
  }

  func layout(in view: UIView, topInset: CGFloat) {
    let inset = ConversationCollectionRow.messageHorizontalInset
    host.view.frame = CGRect(
      x: inset, y: topInset + OkouSpace.lg,
      width: max(0, view.bounds.width - inset * 2), height: OkouControl.skeletonHeight)
  }

  func update() {
    guard needsLoading() else {
      stop()
      return
    }
    guard task == nil, host.view.isHidden else { return }
    task = Task { [weak self, sleep] in
      do { try await sleep(.milliseconds(100)) } catch { return }
      guard !Task.isCancelled, let self, needsLoading() else { return }
      host.view.isHidden = false
    }
  }

  func stop() {
    task?.cancel()
    task = nil
    host.view.isHidden = true
  }
}
