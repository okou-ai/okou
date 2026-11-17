import UIKit

@MainActor
func conversationLayoutFrame() async {
  await withCheckedContinuation { continuation in
    let target = ConversationLayoutFrame(continuation)
    let link = CADisplayLink(target: target, selector: #selector(ConversationLayoutFrame.tick(_:)))
    link.add(to: .main, forMode: .common)
  }
}

@MainActor
private final class ConversationLayoutFrame: NSObject {
  private let continuation: CheckedContinuation<Void, Never>
  private var callbacks = 2
  init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }
  @objc func tick(_ link: CADisplayLink) {
    callbacks -= 1
    guard callbacks == 0 else { return }
    link.invalidate()
    let continuation = continuation
    DispatchQueue.main.async { continuation.resume() }
  }
}
