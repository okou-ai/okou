import ChatDomain
import SwiftUI
import Textual

/// UIKit owns virtualization and exact row sizes. SwiftUI continues to own message rendering.
struct ConversationCollectionView<Content: View>: UIViewControllerRepresentable {
  let rows: [ConversationCollectionRow]
  let markdown: MessageMarkdownCache
  let renderContext: (ChatMessage) -> MessageRenderPlan.Context
  var measurements = ConversationMeasurementCache()
  var contentInsets = EdgeInsets()
  let anchor: ConversationScrollAnchor
  let scroll: ConversationCollectionScroll
  let followsBottom: Bool
  var sendTransition: ConversationSendTransition?
  var isLoadingHistory = false
  let phaseChanged: (ScrollPhase) -> Void
  let metricsChanged: (ConversationCollectionMetrics) -> Void
  let rowsPresented: (String?) -> Void
  var earlierMessages: () -> [ChatMessage] = { [] }
  var quote: ((ChatFeedbackSelection) -> Void)?
  var fork: ((ChatFeedbackSelection) -> Void)?
  let refresh: () async -> Void
  @ViewBuilder let content: (ConversationCollectionRow, ConversationScrollAnchor?) -> Content

  func makeUIViewController(context: Context) -> ConversationCollectionController<Content> {
    let controller = ConversationCollectionController(source: self)
    scroll.attach(controller)
    return controller
  }

  func updateUIViewController(
    _ controller: ConversationCollectionController<Content>, context: Context
  ) {
    controller.update(self)
  }

  static func dismantleUIViewController(
    _ controller: ConversationCollectionController<Content>, coordinator: ()
  ) {
    controller.stop()
  }
}
