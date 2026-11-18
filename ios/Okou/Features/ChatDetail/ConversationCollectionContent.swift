import ChatDomain
import SwiftUI
import Textual

struct ConversationContentInput<Content: View> {
  let source: ConversationCollectionView<Content>
  let measurements: [String: ConversationMeasurementCache.Measurement]
  let rows: [String: ConversationCollectionRow]
  let visibleIndices: @MainActor () -> [Int]
  let itemIDs: @MainActor () -> [String]
  let view: UIView
  let collection: UICollectionView
  let canPrefetch: Bool
}

/// Bounded rendered trees and their original prefetch Task belong to this native control.
@MainActor
final class ConversationCollectionContent<Content: View> {
  private typealias Measurement = ConversationMeasurementCache.Measurement
  private let input: @MainActor () -> ConversationContentInput<Content>?
  private let didObserveHeight: @MainActor (CGFloat, Measurement) -> Void
  private var contentPrefetchContainer: UIView?
  private var prefetchedContent: [String: PrefetchedContent] = [:]
  private var contentOrder: [String] = []
  private var prefetchTask: Task<Void, Never>?
  private var stopped = false

  init(
    input: @escaping @MainActor () -> ConversationContentInput<Content>?,
    didObserveHeight:
      @escaping @MainActor (CGFloat, ConversationMeasurementCache.Measurement) -> Void
  ) {
    self.input = input
    self.didObserveHeight = didObserveHeight
  }

  private final class CellHeightObservation {
    weak var cell: MessageSelectionCell?
    var height: CGFloat?
  }

  private struct PrefetchedContent {
    let measurement: Measurement
    let context: MessageRenderPlan.Context?
    let view: UIView
    let observation: CellHeightObservation
  }

  func configure(
    _ cell: MessageSelectionCell, row: ConversationCollectionRow,
    measurement: ConversationMeasurementCache.Measurement
  ) {
    guard let input = input() else { return }
    let source = input.source
    cell.representedRowID = row.id
    cell.message = row.message
    cell.quote = source.quote
    cell.fork = source.fork
    cell.clipsToBounds = true
    let prepared = prefetchedContent.removeValue(forKey: row.id)
    contentOrder.removeAll { $0 == row.id }
    if let prepared, matchesContent(prepared) {
      showContent(prepared, in: cell)
      if let height = prepared.observation.height {
        didObserveHeight(height, measurement)
      }
    } else {
      prepared?.view.removeFromSuperview()
      let observation = CellHeightObservation()
      observation.cell = cell
      let configuration = messageConfiguration(row, measurement, observation, source: source)
      if canRetainContent(for: row) {
        // Preserve the rendered tree as well as its size when UIKit recycles the cell.
        showContent(
          PrefetchedContent(
            measurement: measurement, context: row.message.map(source.renderContext),
            view: configuration.makeContentView(),
            observation: observation), in: cell)
      } else {
        cell.setMessageConfiguration(configuration)
      }
    }
  }

  private func messageConfiguration(
    _ row: ConversationCollectionRow, _ measurement: Measurement,
    _ observation: CellHeightObservation, source: ConversationCollectionView<Content>
  ) -> some UIContentConfiguration {
    let content = source.content(row, source.anchor)
    return UIHostingConfiguration {
      content
        .id(row.id)
        .frame(width: measurement.width, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { [weak self] height in
          observation.height = height
          guard observation.cell?.representedRowID == row.id else { return }
          self?.didObserveHeight(height, measurement)
        }
        .frame(height: measurement.height, alignment: .topLeading)
    }.margins(.all, 0)
  }

  private func canRetainContent(for row: ConversationCollectionRow) -> Bool {
    guard let input = input() else { return false }
    let source = input.source
    if case .work(let section, false, _, _, _) = row { return section.endTime != nil }
    guard case .message(let message, _, _, nil, false, false, _) = row,
      message.attachments.isEmpty, message.text.utf8.count <= 8_192
    else { return false }
    if message.role == .assistant {
      guard
        let plan = source.markdown.cachedPlan(
          for: message.text, context: source.renderContext(message))
      else { return false }
      return plan.hasStableHeight && plan.resources.isEmpty
    }
    guard message.role == .user, message.modelChange == nil, message.inputError == nil,
      let document = message.userMessage, document.annotation == nil,
      document.bodyParts.count == 1, document.bodyParts.first?.type == "text"
    else { return false }
    return true
  }

  private func showContent(_ content: PrefetchedContent, in cell: MessageSelectionCell) {
    content.observation.cell = cell
    cell.showPrefetchedContent(content.view) { [weak self] view in
      content.observation.cell = nil
      guard let self, !stopped, matchesContent(content)
      else {
        view.removeFromSuperview()
        return
      }
      retainContent(content)
    }
  }

  private func matchesContent(_ content: PrefetchedContent) -> Bool {
    guard let input = input() else { return false }
    let measurements = input.measurements
    let source = input.source
    return measurements[content.measurement.row.id] == content.measurement
      && content.context == content.measurement.row.message.map(source.renderContext)
  }

  private func retainContent(_ content: PrefetchedContent) {
    guard let input = input() else {
      content.view.removeFromSuperview()
      return
    }
    let view = input.view
    let id = content.measurement.row.id
    if let previous = prefetchedContent[id], previous.view !== content.view {
      previous.view.removeFromSuperview()
    }
    let measurement = content.measurement
    let rich = measurement.row.message?.role == .assistant
    let host: UIView = rich ? contentPrefetchHost(in: input.collection) : view
    host.addSubview(content.view)
    content.view.frame = CGRect(
      x: rich ? -measurement.width : -2 * measurement.width, y: 0,
      width: measurement.width, height: measurement.height)
    content.view.isUserInteractionEnabled = false
    content.view.accessibilityElementsHidden = true
    prefetchedContent[id] = content
    contentOrder.removeAll { $0 == id }
    contentOrder.append(id)
    // Keep a bounded set of recently displayed hosts across successive swipes.
    // Completed work headers are cheap to retain alongside the prepared message trees.
    while contentOrder.count > 32 {
      prefetchedContent.removeValue(forKey: contentOrder.removeFirst())?.view.removeFromSuperview()
    }
  }

  func prefetchNearbyContent() {
    prefetchTask?.cancel()
    guard let input = input(), input.canPrefetch else { return }
    let source = input.source
    let displayedRows = input.rows
    // After a prepend, UIKit's visible cell list can lag the restored content offset.
    let visible = input.visibleIndices()
    guard let first = visible.min(), let last = visible.max() else { return }
    let ids = input.itemIDs()
    let above = Array(ids.prefix(first).suffix(14).reversed())
    let below = Array(ids.dropFirst(last + 1).prefix(12))
    let nearby = above + below
    let rich = nearby.filter { id in
      guard case .message(let message, _, _, nil, false, false, _) = displayedRows[id],
        message.role == .assistant, message.attachments.isEmpty,
        (250...8_192).contains(message.text.utf8.count),
        let plan = source.markdown.cachedPlan(
          for: message.text, context: source.renderContext(message))
      else { return false }
      return plan.hasStableHeight && plan.resources.isEmpty
    }
    let plain = nearby.filter { id in
      guard case .message(let message, _, _, nil, false, false, _) = displayedRows[id],
        message.role == .user, message.attachments.isEmpty, message.modelChange == nil,
        message.inputError == nil, let document = message.userMessage,
        document.annotation == nil, document.bodyParts.count == 1,
        let part = document.bodyParts.first, part.type == "text"
      else { return false }
      return part.displayText.utf8.count <= 8_192
    }
    let richIDs = Set(rich.prefix(8))
    let plainIDs = Set(plain.prefix(6))
    // Prepare the expensive rows above the reader first so a quick follow-up swipe can use them.
    let headers = nearby.filter { id in
      if case .work(let section, false, _, _, _) = displayedRows[id] {
        return section.endTime != nil
      }
      return false
    }
    let candidates =
      above.filter { richIDs.contains($0) } + above.filter { plainIDs.contains($0) }
      + below.filter { richIDs.contains($0) } + below.filter { plainIDs.contains($0) }
      + headers
    for (id, content) in prefetchedContent where !matchesContent(content) {
      prefetchedContent.removeValue(forKey: id)?.view.removeFromSuperview()
      contentOrder.removeAll { $0 == id }
    }
    if let container = contentPrefetchContainer, container.subviews.isEmpty {
      container.removeFromSuperview()
      contentPrefetchContainer = nil
    }
    guard candidates.contains(where: { prefetchedContent[$0] == nil }) else { return }
    prefetchTask = Task(priority: .utility) { [weak self] in
      for id in candidates {
        await conversationLayoutFrame()
        guard let self, !Task.isCancelled, let input = self.input(), input.canPrefetch else {
          return
        }
        let source = input.source
        let displayedRows = input.rows
        let measurements = input.measurements
        guard prefetchedContent[id] == nil, let row = displayedRows[id],
          let measurement = measurements[id]
        else { continue }
        let observation = CellHeightObservation()
        let content = messageConfiguration(row, measurement, observation, source: source)
          .makeContentView()
        retainContent(
          .init(
            measurement: measurement, context: row.message.map(source.renderContext),
            view: content, observation: observation))
      }
    }
  }

  private func contentPrefetchHost(in collection: UICollectionView) -> UIView {
    if let contentPrefetchContainer { return contentPrefetchContainer }
    // Give nearby complex rows their scroll-view environment while the reader is idle.
    let container = UIView()
    container.isUserInteractionEnabled = false
    container.accessibilityElementsHidden = true
    container.translatesAutoresizingMaskIntoConstraints = false
    collection.addSubview(container)
    let viewport = collection.frameLayoutGuide
    NSLayoutConstraint.activate([
      container.widthAnchor.constraint(equalTo: viewport.widthAnchor),
      container.heightAnchor.constraint(equalTo: viewport.heightAnchor),
      container.topAnchor.constraint(equalTo: viewport.topAnchor),
      container.trailingAnchor.constraint(equalTo: viewport.leadingAnchor)
    ])
    contentPrefetchContainer = container
    return container
  }

  func clearPrefetchedContent() {
    prefetchTask?.cancel()
    prefetchTask = nil
    for content in prefetchedContent.values { content.view.removeFromSuperview() }
    prefetchedContent.removeAll()
    contentOrder.removeAll()
  }

  func cancelPrefetch() { prefetchTask?.cancel() }

  func stop() {
    stopped = true
    clearPrefetchedContent()
  }
}
