import ChatDomain
import SwiftUI
import Textual

struct ConversationMeasurementInput<Content: View> {
  let controller: UIViewController
  let source: ConversationCollectionView<Content>
  let defersHostedMeasurement: Bool
}

struct ConversationMeasurementLayout {
  let width: CGFloat
  let category: UIContentSizeCategory
  let environment: ConversationHeightDiskCache.Layout
}

@MainActor
final class ConversationRowMeasurer<Content: View> {
  func prepareMissingRows(
    _ missing: [ConversationCollectionRow], source: ConversationCollectionView<Content>,
    layout: ConversationMeasurementLayout,
    preparedMeasurements initial: [String: ConversationMeasurementCache.Measurement],
    isCurrent: @escaping @MainActor () -> Bool
  ) async -> (
    measurements: [String: ConversationMeasurementCache.Measurement],
    settledHeights: [ConversationHeightDiskCache.Key: Double]
  )? {
    typealias Measurement = ConversationMeasurementCache.Measurement
    typealias Measurer = ConversationRowMeasurer<Content>
    let width = layout.width
    let category = layout.category
    let environment = layout.environment
    guard let traits = input()?.controller.traitCollection else { return nil }
    var preparedMeasurements = initial
    let disk = ConversationHeightDiskCache.shared
    var keys: [String: ConversationHeightDiskCache.Key] = [:]
    var warmed = Set<String>()
    if let namespace = source.measurements.namespace, missing.count <= 64 {
      let layout = Measurer.diskLayout(width: width, traits: traits)
      for row in missing {
        guard let message = row.message, message.role == .assistant else { continue }
        await prepareMarkdown(row)
        guard !Task.isCancelled, isCurrent() else { return nil }
        warmed.insert(row.id)
      }
      for row in missing {
        keys[row.id] = Measurer.diskKey(
          for: row, namespace: namespace, layout: layout, source: source)
      }
      if !keys.isEmpty {
        let heights = await disk.heights(for: keys)
        guard !Task.isCancelled, isCurrent() else { return nil }
        for row in missing {
          if let height = heights[row.id] {
            preparedMeasurements[row.id] = Measurement(
              row: row, width: width, category: category, environment: environment,
              height: height, diskKey: keys[row.id])
          }
        }
      }
    }
    let unmeasured = missing.filter { preparedMeasurements[$0.id] == nil }
    var settledHeights: [ConversationHeightDiskCache.Key: Double] = [:]
    // Four temporary hosts at a time bound retained views even in an expanded history.
    for start in stride(from: 0, to: unmeasured.count, by: 4) {
      let batch = Array(unmeasured[start..<min(start + 4, unmeasured.count)])
      for row in batch where !warmed.contains(row.id) {
        await prepareMarkdown(row)
        guard !Task.isCancelled, isCurrent() else { return nil }
      }
      let (heights, settled) = await measure(batch, width: width)
      guard !Task.isCancelled, isCurrent() else { return nil }
      for (row, height) in zip(batch, heights) {
        let key = settled ? keys[row.id] : nil
        if let key { settledHeights[key] = height }
        preparedMeasurements[row.id] = Measurement(
          row: row, width: width, category: category, environment: environment,
          height: height, diskKey: key)
      }
    }
    guard !Task.isCancelled, isCurrent() else { return nil }
    return (preparedMeasurements, settledHeights)
  }

  private var markdownLookahead: Task<Void, Never>?
  private let input: @MainActor () -> ConversationMeasurementInput<Content>?

  init(input: @escaping @MainActor () -> ConversationMeasurementInput<Content>?) {
    self.input = input
  }

  static func diskLayout(width: CGFloat, traits: UITraitCollection)
    -> ConversationHeightDiskCache.Layout
  {
    ConversationHeightDiskCache.Layout(
      width: width, scale: traits.displayScale,
      category: traits.preferredContentSizeCategory.rawValue,
      direction: traits.layoutDirection.rawValue,
      legibility: traits.legibilityWeight.rawValue,
      style: traits.userInterfaceStyle.rawValue, locale: Locale.current.identifier,
      renderer: Self.rendererVersion)
  }

  static func diskKey(
    for row: ConversationCollectionRow, namespace: [String],
    layout: ConversationHeightDiskCache.Layout, source: ConversationCollectionView<Content>
  ) -> ConversationHeightDiskCache.Key? {
    // A row showing the message actions is taller; only rows without them share cached heights.
    guard
      case .message(let message, let avatar, let spacing, nil, false, let work, false) = row.content,
      message.attachments.isEmpty, message.modelChange == nil, message.inputError == nil,
      !message.isError, message.role != .system
    else { return nil }
    var text = message.text
    if message.role == .user, let document = message.userMessage {
      let parts = document.bodyParts
      guard document.annotation == nil, parts.count == 1, let part = parts.first,
        part.type == "text"
      else { return nil }
      text = part.displayText
    } else if message.role == .assistant {
      guard
        source.markdown.cachedPlan(for: text, context: source.renderContext(message))?
          .hasStableHeight == true
      else { return nil }
    }
    return ConversationHeightDiskCache.Key(
      namespace: namespace, id: row.id, text: text, role: message.role.rawValue,
      showsAvatar: avatar, spacing: spacing, workHistory: work, layout: layout)
  }

  func measure(
    _ rows: [ConversationCollectionRow], width: CGFloat
  ) async -> (heights: [CGFloat], settled: Bool) {
    if input()?.defersHostedMeasurement == true, !(await waitForMeasurementFrame()) {
      return ([], false)
    }
    guard let input = input() else { return ([], false) }
    let parent = input.controller
    let source = input.source
    let layout = Self.diskLayout(width: width, traits: parent.traitCollection)
    var unitSessions: [MessageUnitMeasurements.Session] = []
    let hosts = rows.map { row in
      let unitSession: MessageUnitMeasurements.Session?
      if case .message(let answer, _, _, _, _, false, _) = row.content, answer.role == .assistant {
        let session = MessageUnitMeasurements.Session(
          cache: source.markdown.unitMeasurements, layout: layout)
        unitSessions.append(session)
        unitSession = session
      } else {
        unitSession = nil
      }
      let host = UIHostingController(
        rootView: source.content(row, nil)
          .environment(\.messageUnitMeasurement, unitSession)
          .fixedSize(horizontal: false, vertical: true))
      // System bars must not contribute to intrinsic row sizes in the offscreen measurement host.
      host.safeAreaRegions = []
      parent.addChild(host)
      host.view.isUserInteractionEnabled = false
      host.view.accessibilityElementsHidden = true
      host.view.frame = CGRect(x: -width * 2, y: 0, width: width, height: 1)
      parent.view.addSubview(host.view)
      host.didMove(toParent: parent)
      return host
    }
    defer {
      for host in hosts {
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
      }
    }
    var previous: [CGFloat] = []
    var stableFrames = 0
    // Textual populates its initial state and nested overflow geometry after mounting.
    // Later asynchronous attachment growth is measured separately by visible cells.
    for _ in 0..<30 {
      guard await waitForMeasurementFrame() else { return (previous, false) }
      let heights = hosts.map { host in
        let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        let height = Self.pixelHeight(size.height, scale: parent.traitCollection.displayScale)
        host.view.frame.size.height = height
        host.view.layoutIfNeeded()
        return height
      }
      stableFrames = heights == previous ? stableFrames + 1 : 0
      previous = heights
      if stableFrames >= 2 {
        for session in unitSessions { session.commit() }
        return (previous, true)
      }
    }
    return (previous, false)
  }

  func waitForMeasurementFrame() async -> Bool {
    repeat {
      await conversationLayoutFrame()
      guard !Task.isCancelled else { return false }
    } while input()?.defersHostedMeasurement == true
    return true
  }

  func measureImmediately(
    _ rows: [ConversationCollectionRow], width: CGFloat
  ) -> [CGFloat] {
    guard let input = input() else { return [] }
    let traitCollection = input.controller.traitCollection
    return rows.map { row in
      switch row.content {
      case .message(let message, _, let topSpacing, _, _, _, _):
        let font = OkouTypography.font(forTextStyle: .body, compatibleWith: traitCollection)
        let text = NSAttributedString(string: message.text, attributes: [.font: font])
        let size = text.boundingRect(
          with: CGSize(width: (width - 40) * 0.85 - 28, height: .greatestFiniteMagnitude),
          options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        return Self.pixelHeight(
          size.height + 28 + topSpacing, scale: traitCollection.displayScale)
      case .footer(let state, let showsAvatar):
        return Self.footerHeight(state: state, showsAvatar: showsAvatar, traits: traitCollection)
      default:
        preconditionFailure("Only outgoing plain text and its footer use immediate metrics")
      }
    }
  }

  static func footerHeight(
    state: ChatExecutionState, showsAvatar: Bool, traits: UITraitCollection
  ) -> CGFloat {
    Self.pixelHeight(
      ConversationFooterView.measuredHeight(for: state, showsAvatar: showsAvatar, traits: traits),
      scale: traits.displayScale)
  }

  static func pixelHeight(_ height: CGFloat, scale: CGFloat) -> CGFloat {
    max(1, ceil(height * scale) / scale)
  }

  func prepareMarkdown(_ row: ConversationCollectionRow) async {
    guard let input = input() else { return }
    let source = input.source
    guard let message = row.message,
      message.role == .assistant || (message.role == .user && message.userMessage == nil)
    else { return }
    _ = await source.markdown.renderPlan(
      for: message.text, context: source.renderContext(message))
  }

  private static var rendererVersion: String {
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    return build + "/upstream-render-units-1/"
      + ProcessInfo.processInfo.operatingSystemVersionString
  }

  func prepareEarlierMarkdown() {
    guard let input = input() else { return }
    let source = input.source
    markdownLookahead?.cancel()
    markdownLookahead = nil
    let messages = source.earlierMessages().lazy.filter { $0.role == .assistant }.suffix(10)
    guard !messages.isEmpty else { return }
    let requests = Array(messages.reversed()).map { ($0.text, source.renderContext($0)) }
    let markdown = source.markdown
    markdownLookahead = Task(priority: .utility) {
      for (text, context) in requests {
        guard !Task.isCancelled else { return }
        _ = await markdown.renderPlan(for: text, context: context)
      }
    }
  }

  func close() {
    markdownLookahead?.cancel()
    markdownLookahead = nil
  }
}
