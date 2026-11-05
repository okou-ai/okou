import ChatDomain
import SwiftUI
import Textual

/// Presentation revisions include every input that can change a row's measured size.
enum ConversationCollectionRow: Equatable, Identifiable {
  case earlier
  case message(
    ChatMessage, showsAvatar: Bool, topSpacing: CGFloat, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool = false, showsActions: Bool = false)
  case work(
    ChatWorkSection, expanded: Bool, showsAvatar: Bool, topSpacing: CGFloat, failed: Bool = false)
  case footer(ChatExecutionState, showsAvatar: Bool)
  case failure(
    ChatMessage, AssistantFailureState, topSpacing: CGFloat, providerMessage: String? = nil)
  case followups(ChatRecommendedFollowupSource, finishedAt: Date?)
  case usage(runID: String, state: ConversationRunUsageState)

  static let messageHorizontalInset: CGFloat = 20
  static let assistantLeadingInset: CGFloat = 6

  var id: String {
    switch self {
    case .earlier: "conversation-earlier"
    case .message(let message, _, _, _, _, _, _): message.id
    case .work(let section, _, _, _, _): section.id
    case .footer: "conversation-bottom"
    case .failure(let message, _, _, _): message.id
    case .followups: "conversation-followups"
    case .usage(let runID, _): "usage:\(runID)"
    }
  }

  var message: ChatMessage? {
    if case .message(let message, _, _, _, _, _, _) = self { return message }
    if case .failure(let message, _, _, _) = self { return message }
    return nil
  }

  var isMessageContent: Bool {
    switch self {
    case .message, .failure, .work: true
    case .earlier, .footer, .followups, .usage: false
    }
  }

  var readingContentTopSpacing: CGFloat? {
    switch self {
    case .message(_, _, let spacing, _, _, _, _), .work(_, _, _, let spacing, _),
      .failure(_, _, let spacing, _):
      spacing
    case .usage: 0
    case .earlier, .footer, .followups: nil
    }
  }
}

struct ConversationCollectionMetrics: Equatable {
  let height: CGFloat
  let offset: CGFloat
  let isNearTop: Bool
  let isAwayFromBottom: Bool
}

@MainActor
private protocol ConversationCollectionScrolling: AnyObject {
  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool)
  func captureReadingPosition() -> ConversationReadingPosition?
}

@MainActor
final class ConversationCollectionScroll {
  fileprivate weak var owner: (any ConversationCollectionScrolling)?
  private var request: (String, UnitPoint, Bool)?

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool = false) {
    guard let owner else {
      request = (id, anchor, animated)
      return
    }
    owner.scrollTo(id, anchor: anchor, animated: animated)
  }

  func captureReadingPosition() -> ConversationReadingPosition? {
    owner?.captureReadingPosition()
  }

  fileprivate func attach(_ owner: any ConversationCollectionScrolling) {
    self.owner = owner
    if let request {
      self.request = nil
      owner.scrollTo(request.0, anchor: request.1, animated: request.2)
    }
  }
}

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
  var sidebar: SidebarInteraction?
  var sendTransition: ConversationSendTransition?
  var isLoadingHistory = false
  let phaseChanged: (ScrollPhase) -> Void
  let metricsChanged: (ConversationCollectionMetrics) -> Void
  let rowsPresented: (String?) -> Void
  var earlierMessages: () -> [ChatMessage] = { [] }
  var quote: ((ChatFeedbackSelection) -> Void)? = nil
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

@MainActor
final class ConversationCollectionController<Content: View>: UIViewController,
  UICollectionViewDelegateFlowLayout, ConversationCollectionScrolling, SidebarScrollParticipant
{
  private typealias Measurement = ConversationMeasurementCache.Measurement

  private struct PreparedRows {
    let rows: [ConversationCollectionRow]
    let measurements: [String: Measurement]
  }

  private struct ObservedHeight {
    let row: ConversationCollectionRow
    let width: CGFloat
    let category: UIContentSizeCategory
    let height: CGFloat
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

  private let layout = UICollectionViewFlowLayout()
  private var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var source: ConversationCollectionView<Content>
  private var measurements: [String: Measurement] = [:]
  private var displayedRows: [String: ConversationCollectionRow] = [:]
  private var markdownLookahead: Task<Void, Never>?
  private var contentPrefetchContainer: UIView?
  private var prefetchedContent: [String: PrefetchedContent] = [:]
  private var contentOrder: [String] = []
  private var prefetchTask: Task<Void, Never>?
  private var displayedWidth: CGFloat = 0
  private var displayedCategory = UIContentSizeCategory.unspecified
  private var preparation: Task<Void, Never>?
  private var preparationID = UUID()
  private var requestedRows: [ConversationCollectionRow] = []
  private var requestedWidth: CGFloat = 0
  private var requestedCategory = UIContentSizeCategory.unspecified
  private var requestedEnvironment: ConversationHeightDiskCache.Layout?
  private var preparedRows: PreparedRows?
  private var appliesRows = false
  private var pendingScroll: (String, UnitPoint, Bool)?
  private var lastMetrics: ConversationCollectionMetrics?
  private var publishesMetrics = false
  private var lastViewportSize = CGSize.zero
  private var publishesViewport = false
  private var resizeTasks: [String: Task<Void, Never>] = [:]
  private var resizeIDs: [String: UUID] = [:]
  private var observedHeights: [String: ObservedHeight] = [:]
  private var refreshTask: Task<Void, Never>?
  private var stopped = false
  private var animatesScroll = false
  private let loading = UIActivityIndicatorView(style: .medium)
  private var loadingTask: Task<Void, Never>?
  private let sleep: @MainActor (Duration) async throws -> Void

  init(
    source: ConversationCollectionView<Content>,
    sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.source = source
    self.sleep = sleep
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    layout.estimatedItemSize = .zero
    collection = ConversationAccessibilityCollection(
      frame: view.bounds, collectionViewLayout: layout)
    collection.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    collection.backgroundColor = .clear
    collection.alwaysBounceVertical = true
    // The header and composer insets are safe-area insets (see updateContentInsets), so the
    // native edge effects cover the whole bar instead of only the status bar band. The header
    // has only glass controls and no title, so the soft blur is enough at both edges.
    collection.contentInsetAdjustmentBehavior = .always
    collection.topEdgeEffect.style = .soft
    collection.bottomEdgeEffect.style = .soft
    collection.keyboardDismissMode = .interactive
    collection.selfSizingInvalidation = .disabled
    collection.register(MessageSelectionCell.self, forCellWithReuseIdentifier: "message")
    collection.delegate = self
    source.sendTransition?.attach(collection)
    source.sendTransition?.didBegin = { [weak self] in
      guard let self else { return }
      pendingScroll = nil
      collection.stopScrollingAndZooming()
      animatesScroll = false
      if let footer = dataSource.indexPath(for: "conversation-bottom"),
        let frame = collection.layoutAttributesForItem(at: footer)?.frame
      {
        let lastContent = source.rows.last(where: { $0.isMessageContent })
        let spacing: CGFloat =
          lastContent == nil ? 20 : (lastContent?.message?.role == .user ? 8 : 24)
        source.sendTransition?.projectFlight(insertionY: frame.minY, topSpacing: spacing)
      }
      source.phaseChanged(.animating)
    }
    source.sendTransition?.didFinish = { [weak self] in
      guard let self else { return }
      source.anchor.followBottom()
      scrollingEnded()
    }
    updateContentInsets()
    (collection as? ConversationAccessibilityCollection)?.beginsAccessibilityScroll = {
      [weak self] in
      guard let self else { return }
      source.sendTransition?.cancel()
      pendingScroll = nil
      animatesScroll = true
      source.phaseChanged(.interacting)
    }
    let refresh = UIRefreshControl()
    refresh.addTarget(self, action: #selector(refreshConversation), for: .valueChanged)
    collection.refreshControl = refresh
    view.addSubview(collection)
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) {
      [weak self] collection, index, id in
      guard let self else { return nil }
      guard
        let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: index)
          as? MessageSelectionCell
      else { preconditionFailure("Expected a message cell") }
      guard let row = self.displayedRows[id], let measurement = self.measurements[id] else {
        preconditionFailure("Every displayed conversation row must have a measurement")
      }
      cell.representedRowID = row.id
      cell.message = row.message
      cell.quote = source.quote
      cell.clipsToBounds = true
      let prepared = prefetchedContent.removeValue(forKey: row.id)
      contentOrder.removeAll { $0 == row.id }
      if let prepared, matchesContent(prepared) {
        showContent(prepared, in: cell)
        if let height = prepared.observation.height {
          observeHeight(
            height, row: row, width: measurement.width, category: measurement.category,
            environment: measurement.environment)
        }
      } else {
        prepared?.view.removeFromSuperview()
        let observation = CellHeightObservation()
        observation.cell = cell
        let configuration = messageConfiguration(row, measurement, observation)
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
      return cell
    }
    source.anchor.isPresentedMarker = { [weak self] marker in
      self?.isPresentedMarker(marker) ?? false
    }
    loading.hidesWhenStopped = true
    loading.isUserInteractionEnabled = false
    loading.isAccessibilityElement = true
    loading.accessibilityLabel = String(localized: "Loading chat")
    view.addSubview(loading)
    source.sidebar?.attach(self)
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitLayoutDirection.self,
      UITraitLegibilityWeight.self, UITraitDisplayScale.self,
      UITraitUserInterfaceStyle.self,
    ]) {
      (controller: ConversationCollectionController<Content>, _: UITraitCollection) in
      controller.publishViewportChange()
      controller.prepareRowsIfNeeded()
    }
  }

  private func messageConfiguration(
    _ row: ConversationCollectionRow, _ measurement: Measurement,
    _ observation: CellHeightObservation
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
          self?.observeHeight(
            height, row: row, width: measurement.width, category: measurement.category,
            environment: measurement.environment)
        }
        .frame(height: measurement.height, alignment: .topLeading)
    }.margins(.all, 0)
  }

  private var canPrefetchContent: Bool {
    !stopped && !isScrolling && !appliesRows && view.window != nil
      && collection.isUserInteractionEnabled && source.sendTransition?.isActive != true
  }

  private func canRetainContent(for row: ConversationCollectionRow) -> Bool {
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
    measurements[content.measurement.row.id] == content.measurement
      && content.context == content.measurement.row.message.map(source.renderContext)
  }

  private func retainContent(_ content: PrefetchedContent) {
    let id = content.measurement.row.id
    if let previous = prefetchedContent[id], previous.view !== content.view {
      previous.view.removeFromSuperview()
    }
    let measurement = content.measurement
    let rich = measurement.row.message?.role == .assistant
    let host: UIView = rich ? contentPrefetchHost() : view
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

  private func prefetchNearbyContent() {
    prefetchTask?.cancel()
    guard canPrefetchContent else { return }
    // After a prepend, UIKit's visible cell list can lag the restored content offset.
    let visible = (layout.layoutAttributesForElements(in: collection.bounds) ?? []).compactMap {
      $0.representedElementCategory == .cell ? $0.indexPath.item : nil
    }
    guard let first = visible.min(), let last = visible.max() else { return }
    let ids = dataSource.snapshot().itemIdentifiers
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
        guard let self, !Task.isCancelled, canPrefetchContent else { return }
        guard prefetchedContent[id] == nil, let row = displayedRows[id],
          let measurement = measurements[id]
        else { continue }
        let observation = CellHeightObservation()
        let content = messageConfiguration(row, measurement, observation).makeContentView()
        retainContent(
          .init(
            measurement: measurement, context: row.message.map(source.renderContext),
            view: content, observation: observation))
      }
    }
  }

  private func contentPrefetchHost() -> UIView {
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
      container.trailingAnchor.constraint(equalTo: viewport.leadingAnchor),
    ])
    contentPrefetchContainer = container
    return container
  }

  private func clearPrefetchedContent() {
    prefetchTask?.cancel()
    prefetchTask = nil
    for content in prefetchedContent.values { content.view.removeFromSuperview() }
    prefetchedContent.removeAll()
    contentOrder.removeAll()
  }

  override func didReceiveMemoryWarning() {
    super.didReceiveMemoryWarning()
    clearPrefetchedContent()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    loading.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    if collection.bounds.size != lastViewportSize {
      lastViewportSize = collection.bounds.size
      publishViewportChange()
    }
    prepareRowsIfNeeded()
    source.sendTransition?.layoutDidChange()
    publishMetrics()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    publishViewportChange()
    source.sendTransition?.layoutDidChange()
    publishMetrics()
  }

  private func publishViewportChange() {
    guard !publishesViewport else { return }
    publishesViewport = true
    source.anchor.layoutDidChange()
    // Preserve intent before a width/font snapshot can replace its geometry.
    // This callback only updates the non-observable anchor, not SwiftUI state.
    if !isScrolling { source.anchor.viewportDidChange?() }
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesViewport = false
    }
  }

  func update(_ source: ConversationCollectionView<Content>) {
    let sidebarChanged = self.source.sidebar !== source.sidebar
    if sidebarChanged, isViewLoaded { self.source.sidebar?.detach(self) }
    self.source = source
    if isViewLoaded {
      if sidebarChanged { source.sidebar?.attach(self) }
      updateContentInsets()
      prepareRowsIfNeeded()
    }
  }

  private func updateContentInsets() {
    // Header and composer heights extend the safe area rather than the content inset:
    // adjustedContentInset stays the same, and UIKit's scroll edge effects follow the
    // safe area, so they now reach under both bars.
    let bars = UIEdgeInsets(
      top: source.contentInsets.top, left: 0, bottom: source.contentInsets.bottom, right: 0)
    let horizontal = UIEdgeInsets(
      top: 0, left: source.contentInsets.leading, bottom: 0, right: source.contentInsets.trailing)
    guard additionalSafeAreaInsets != bars || collection.contentInset != horizontal else { return }
    additionalSafeAreaInsets = bars
    collection.contentInset = horizontal
    view.layoutIfNeeded()
    source.sendTransition?.layoutDidChange()
    publishViewportChange()
    publishMetrics()
  }

  func stop() {
    source.sidebar?.detach(self)
    stopped = true
    clearPrefetchedContent()
    markdownLookahead?.cancel()
    markdownLookahead = nil
    source.sendTransition?.cancel()
    source.sendTransition?.didBegin = nil
    source.sendTransition?.didFinish = nil
    stopLoading()
    preparation?.cancel()
    preparation = nil
    refreshTask?.cancel()
    refreshTask = nil
    for task in resizeTasks.values { task.cancel() }
    resizeTasks.removeAll()
    resizeIDs.removeAll()
    observedHeights.removeAll()
    if source.scroll.owner === self { source.scroll.owner = nil }
    source.anchor.isPresentedMarker = nil
    collection?.delegate = nil
  }

  func setSidebarActive(_ active: Bool) {
    guard isViewLoaded else { return }
    let enabled = !active
    guard collection.isUserInteractionEnabled != enabled else { return }
    let wasScrolling = isScrolling || source.sendTransition?.isActive == true
    // Cancel this touch's transcript pan and block new transcript touches. Keep
    // isScrollEnabled unchanged: UIHostingConfiguration needs its scroll-container
    // layout semantics even when the sidebar is covering a newly mounted detail.
    // Ancestor SwiftUI responder/relationship recognizers must keep running.
    collection.isUserInteractionEnabled = enabled
    collection.panGestureRecognizer.isEnabled = enabled
    if active {
      source.sendTransition?.cancel()
      collection.stopScrollingAndZooming()
      // A newly mounted detail must still restore its saved position while the
      // sidebar is open. Only interrupted motion relinquishes its correction.
      if wasScrolling {
        source.phaseChanged(.interacting)
        source.anchor.cancel()
        scrollingEnded()
      }
    }
  }

  private func isPresentedMarker(_ marker: ConversationRowMarker) -> Bool {
    // Marker readiness must honor the same measurement boundary as scroll metrics.
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory
    else { return false }
    guard let index = dataSource.indexPath(for: marker.messageID),
      let cell = collection.cellForItem(at: index)
    else { return false }
    // Reconfiguration can retain a previous hosting tree. Only the native
    // cell for this message and content inside its clipping bounds can anchor it.
    var ancestor = marker.superview
    while let view = ancestor {
      if view === cell {
        // Reused SwiftUI content can briefly wrap at a near-zero width and overflow
        // its measured cell. That temporary box must not become a reading anchor.
        let rect = marker.convert(marker.bounds, to: cell)
        let pixel = 1 / traitCollection.displayScale
        return rect.width > 0 && rect.height > 0
          && cell.bounds.insetBy(dx: -pixel, dy: -pixel).contains(rect)
      }
      ancestor = view.superview
    }
    return false
  }

  private func prepareRowsIfNeeded() {
    defer { updateLoading() }
    guard !stopped, collection.bounds.width > 0 else { return }
    let width = collection.bounds.width
    let category = traitCollection.preferredContentSizeCategory
    let environment = diskLayout(width: width)
    guard
      requestedRows != source.rows || requestedWidth != width || requestedCategory != category
        || requestedEnvironment != environment
    else { return }
    if requestedEnvironment != environment {
      clearPrefetchedContent()
    }
    requestedRows = source.rows
    requestedWidth = width
    requestedCategory = category
    requestedEnvironment = environment
    preparation?.cancel()
    preparation = nil
    let generation = UUID()
    preparationID = generation
    preparedRows = nil
    let rows = source.rows
    var preparedMeasurements: [String: Measurement] = [:]
    for row in rows {
      if let measured = measurements[row.id], measured.row == row, measured.width == width,
        measured.category == category, measured.environment == environment
      {
        preparedMeasurements[row.id] = measured
      } else if let measured = source.measurements.measurement(
        for: row, width: width, category: category, environment: environment)
      {
        preparedMeasurements[row.id] = measured
      }
    }
    let missing = rows.filter { preparedMeasurements[$0.id] == nil }
    let validIDs = Set(rows.map(\.id)).subtracting(missing.map(\.id))
    for id in resizeTasks.keys where !validIDs.contains(id) {
      resizeTasks.removeValue(forKey: id)?.cancel()
      resizeIDs.removeValue(forKey: id)
    }
    observedHeights = observedHeights.filter { validIDs.contains($0.key) }
    // Measure the outgoing literal text without mounting temporary SwiftUI trees
    // on the send's first animation frames. Other rows keep their hosted measurement.
    let measuresImmediately =
      source.sendTransition?.hidesBubbleID != nil
      && missing.allSatisfy { row in
        switch row {
        case .message(let message, _, _, _, _, _, _):
          message.id == source.sendTransition?.messageID
            && message.role == .user && message.attachments.isEmpty && message.modelChange == nil
            && message.inputError == nil
            && message.userMessage?.parts.allSatisfy { $0.type == "text" } == true
        case .footer(_, let showsAvatar): !showsAvatar
        default: false
        }
      }
    if measuresImmediately {
      for (row, height) in zip(missing, measureImmediately(missing, width: width)) {
        preparedMeasurements[row.id] = Measurement(
          row: row, width: width, category: category, environment: environment, height: height)
      }
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
      return
    }
    if missing.isEmpty {
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
      return
    }
    preparation = Task { [weak self] in
      guard let self else { return }
      let disk = ConversationHeightDiskCache.shared
      var keys: [String: ConversationHeightDiskCache.Key] = [:]
      var warmed = Set<String>()
      if let namespace = source.measurements.namespace, missing.count <= 64 {
        let layout = diskLayout(width: width)
        for row in missing {
          guard let message = row.message, message.role == .assistant else { continue }
          await prepareMarkdown(row)
          guard !Task.isCancelled, preparationID == generation else { return }
          warmed.insert(row.id)
        }
        for row in missing {
          keys[row.id] = diskKey(for: row, namespace: namespace, layout: layout)
        }
        if !keys.isEmpty {
          let heights = await disk.heights(for: keys)
          guard !Task.isCancelled, preparationID == generation else { return }
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
          guard !Task.isCancelled, preparationID == generation else { return }
        }
        let (heights, settled) = await measure(batch, width: width)
        guard !Task.isCancelled, preparationID == generation else { return }
        for (row, height) in zip(batch, heights) {
          let key = settled ? keys[row.id] : nil
          if let key { settledHeights[key] = height }
          preparedMeasurements[row.id] = Measurement(
            row: row, width: width, category: category, environment: environment,
            height: height, diskKey: key)
        }
      }
      guard !Task.isCancelled, preparationID == generation, !stopped else { return }
      preparation = nil
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
      if !settledHeights.isEmpty { await disk.store(settledHeights) }
    }
  }

  private func prepareMarkdown(_ row: ConversationCollectionRow) async {
    guard let message = row.message,
      message.role == .assistant || (message.role == .user && message.userMessage == nil)
    else { return }
    _ = await source.markdown.renderPlan(
      for: message.text, context: source.renderContext(message))
  }

  private func prepareEarlierMarkdown() {
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

  private var needsLoadingIndicator: Bool {
    !stopped && !displayedRows.values.contains(where: \.isMessageContent)
      && (source.isLoadingHistory || source.rows.contains(where: \.isMessageContent))
  }

  private func updateLoading() {
    guard needsLoadingIndicator else {
      stopLoading()
      return
    }
    guard loadingTask == nil, !loading.isAnimating else { return }
    loadingTask = Task { [weak self, sleep] in
      do { try await sleep(.milliseconds(100)) } catch { return }
      guard !Task.isCancelled, let self, needsLoadingIndicator else { return }
      loading.startAnimating()
    }
  }

  private func stopLoading() {
    loadingTask?.cancel()
    loadingTask = nil
    loading.stopAnimating()
  }

  private func diskLayout(width: CGFloat) -> ConversationHeightDiskCache.Layout {
    ConversationHeightDiskCache.Layout(
      width: width, scale: traitCollection.displayScale,
      category: traitCollection.preferredContentSizeCategory.rawValue,
      direction: traitCollection.layoutDirection.rawValue,
      legibility: traitCollection.legibilityWeight.rawValue,
      style: traitCollection.userInterfaceStyle.rawValue, locale: Locale.current.identifier,
      renderer: Self.rendererVersion)
  }

  private static var rendererVersion: String {
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    return build + "/upstream-render-units-1/"
      + ProcessInfo.processInfo.operatingSystemVersionString
  }

  private func diskKey(
    for row: ConversationCollectionRow, namespace: [String],
    layout: ConversationHeightDiskCache.Layout
  ) -> ConversationHeightDiskCache.Key? {
    // A row showing the message actions is taller; only rows without them share cached heights.
    guard case .message(let message, let avatar, let spacing, nil, false, let work, false) = row,
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

  private func measure(
    _ rows: [ConversationCollectionRow], width: CGFloat
  ) async -> (heights: [CGFloat], settled: Bool) {
    if defersHostedMeasurement, !(await waitForMeasurementFrame()) { return ([], false) }
    let layout = diskLayout(width: width)
    var unitSessions: [MessageUnitMeasurements.Session] = []
    let hosts = rows.map { row in
      let unitSession: MessageUnitMeasurements.Session?
      if case .message(let message, _, _, _, _, false, _) = row, message.role == .assistant {
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
      addChild(host)
      host.view.isUserInteractionEnabled = false
      host.view.accessibilityElementsHidden = true
      host.view.frame = CGRect(x: -width * 2, y: 0, width: width, height: 1)
      view.addSubview(host.view)
      host.didMove(toParent: self)
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
        let height = pixelHeight(size.height)
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

  private var defersHostedMeasurement: Bool {
    isScrolling && source.sendTransition?.isActive != true
  }

  private func waitForMeasurementFrame() async -> Bool {
    repeat {
      await conversationLayoutFrame()
      guard !Task.isCancelled else { return false }
    } while defersHostedMeasurement
    return true
  }

  private func measureImmediately(_ rows: [ConversationCollectionRow], width: CGFloat) -> [CGFloat]
  {
    rows.map { row in
      switch row {
      case .message(let message, _, let topSpacing, let pendingRetry, _, _, _):
        let font = OkouTypography.font(forTextStyle: .body, compatibleWith: traitCollection)
        let text = NSAttributedString(string: message.text, attributes: [.font: font])
        let size = text.boundingRect(
          with: CGSize(width: (width - 40) * 0.85 - 28, height: .greatestFiniteMagnitude),
          options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
        let status =
          pendingRetry == nil
          ? 0
          : 8
            + OkouTypography.font(
              forTextStyle: .caption1, compatibleWith: traitCollection
            ).lineHeight
        return pixelHeight(size.height + 28 + topSpacing + status)
      case .footer(let state, _):
        return pixelHeight(45 + (state.isActive ? 48 : 0))
      default:
        preconditionFailure("Only outgoing plain text and its footer use immediate metrics")
      }
    }
  }

  private func pixelHeight(_ height: CGFloat) -> CGFloat {
    let scale = traitCollection.displayScale
    return max(1, ceil(height * scale) / scale)
  }

  private var isScrolling: Bool {
    // A send can accept measured updates and retarget its own animation.
    animatesScroll || collection.isTracking || collection.isDragging || collection.isDecelerating
  }

  private func applyPreparedRows() {
    guard let prepared = preparedRows, !isScrolling, !appliesRows else { return }
    source.sendTransition?.prepareForSnapshot()
    preparedRows = nil
    appliesRows = true
    let rows = prepared.rows
    let ids = Set(rows.map(\.id))
    let position = source.anchor.preservedPosition ?? captureReadingPosition(retaining: ids)
    if !source.followsBottom, let position { source.anchor.preserve(position) }
    let oldIDs = Set(dataSource.snapshot().itemIdentifiers)
    var updatedMeasurements = prepared.measurements
    for row in rows {
      if let current = measurements[row.id], let prepared = updatedMeasurements[row.id],
        current.row == prepared.row, current.width == prepared.width,
        current.category == prepared.category, current.environment == prepared.environment
      {
        updatedMeasurements[row.id] = current
      }
    }
    let changed = rows.filter {
      oldIDs.contains($0.id)
        && (displayedRows[$0.id] != $0 || measurements[$0.id] != updatedMeasurements[$0.id])
    }.map(\.id)
    for row in rows { displayedRows[row.id] = row }
    measurements = updatedMeasurements
    for row in rows {
      if let measurement = measurements[row.id] { source.measurements.store(measurement) }
    }
    displayedWidth = requestedWidth
    displayedCategory = requestedCategory
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(rows.map(\.id))
    snapshot.reconfigureItems(changed)
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self, !stopped else { return }
      appliesRows = false
      displayedRows = displayedRows.filter { ids.contains($0.key) }
      measurements = measurements.filter { ids.contains($0.key) }
      collection.layoutIfNeeded()
      updateLoading()
      let firstItemID = rows.first(where: { $0.readingContentTopSpacing != nil })?.id
      DispatchQueue.main.async { [weak self] in
        guard let self, !stopped else { return }
        source.rowsPresented(firstItemID)
        prepareEarlierMarkdown()
        prefetchNearbyContent()
      }
      if isScrolling {
        publishMetrics()
        return
      }
      if source.sendTransition?.isActive == true {
        let messageID = source.sendTransition?.messageID
        let indexPath = messageID.flatMap { dataSource.indexPath(for: $0) }
        let cell = indexPath.flatMap { collection.cellForItem(at: $0) }
        var messageFrame = indexPath.flatMap { collection.layoutAttributesForItem(at: $0)?.frame }
        if let id = messageID, let spacing = displayedRows[id]?.readingContentTopSpacing {
          messageFrame?.origin.y += spacing
          messageFrame?.size.height -= spacing
        }
        source.sendTransition?.presentIfReady(
          in: ids, arrivingView: cell, messageFrame: messageFrame)
      } else if let pendingScroll {
        self.pendingScroll = nil
        scrollTo(pendingScroll.0, anchor: pendingScroll.1, animated: pendingScroll.2)
      } else if source.followsBottom {
        source.anchor.followBottom()
        scrollTo("conversation-bottom", anchor: .bottom, animated: false)
      } else if let position, ids.contains(position.messageID) {
        // Compensate before the next frame, even when SwiftUI row markers are not mounted yet.
        restoreReadingPosition(position)
        source.anchor.restore(position)
      }
      source.anchor.layoutDidChange()
      publishMetrics()
      applyPreparedRows()
      applyObservedHeights()
    }
  }

  func captureReadingPosition() -> ConversationReadingPosition? {
    captureReadingPosition(retaining: nil)
  }

  private func captureReadingPosition(retaining ids: Set<String>?) -> ConversationReadingPosition? {
    guard isViewLoaded, displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory
    else { return nil }
    let top = collection.bounds.minY + collection.adjustedContentInset.top
    let bottom = collection.bounds.maxY - collection.adjustedContentInset.bottom
    return collection.indexPathsForVisibleItems.compactMap {
      index -> ConversationReadingPosition? in
      guard let id = dataSource.itemIdentifier(for: index), ids?.contains(id) ?? true,
        let spacing = displayedRows[id]?.readingContentTopSpacing,
        let frame = layout.layoutAttributesForItem(at: index)?.frame,
        frame.maxY > top, frame.minY + spacing < bottom
      else { return nil }
      return ConversationReadingPosition(messageID: id, offset: frame.minY + spacing - top)
    }.min { $0.offset < $1.offset }
  }

  private func restoreReadingPosition(_ position: ConversationReadingPosition) {
    guard displayedWidth == collection.bounds.width,
      displayedCategory == traitCollection.preferredContentSizeCategory,
      let index = dataSource.indexPath(for: position.messageID),
      let spacing = displayedRows[position.messageID]?.readingContentTopSpacing,
      let frame = layout.layoutAttributesForItem(at: index)?.frame
    else { return }
    let insets = collection.adjustedContentInset
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let y = min(maximum, max(minimum, frame.minY + spacing - insets.top - position.offset))
    guard abs(y - collection.contentOffset.y) > 0.5 else { return }
    collection.setContentOffset(CGPoint(x: collection.contentOffset.x, y: y), animated: false)
  }

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool) {
    guard source.sendTransition?.isActive != true else { return }
    guard isViewLoaded, let index = dataSource.indexPath(for: id) else {
      pendingScroll = (id, anchor, animated)
      return
    }
    collection.layoutIfNeeded()
    guard let attributes = layout.layoutAttributesForItem(at: index) else { return }
    let insets = collection.adjustedContentInset
    let minimum = -insets.top
    let maximum = max(
      minimum, collection.contentSize.height - collection.bounds.height + insets.bottom)
    let requested =
      anchor == .bottom
      ? attributes.frame.maxY - collection.bounds.height + insets.bottom
      : attributes.frame.minY - insets.top
    let y = min(maximum, max(minimum, requested))
    guard abs(y - collection.contentOffset.y) > 0.5 else {
      if animatesScroll {
        collection.setContentOffset(collection.contentOffset, animated: false)
        scrollingEnded()
      }
      publishMetrics()
      return
    }
    let interruptedAnimation = animatesScroll && !animated
    animatesScroll = animated
    if animated { source.phaseChanged(.animating) }
    collection.setContentOffset(CGPoint(x: 0, y: y), animated: animated)
    if interruptedAnimation { scrollingEnded() } else if !animated { publishMetrics() }
  }

  func collectionView(
    _ collectionView: UICollectionView, layout collectionViewLayout: UICollectionViewLayout,
    sizeForItemAt indexPath: IndexPath
  ) -> CGSize {
    guard let id = dataSource.itemIdentifier(for: indexPath), let measurement = measurements[id]
    else { preconditionFailure("Every collection item must have a measured conversation row") }
    return CGSize(width: collectionView.bounds.width, height: measurement.height)
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    prefetchTask?.cancel()
    source.sendTransition?.cancel()
    pendingScroll = nil
    animatesScroll = false
    source.phaseChanged(.interacting)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    source.sendTransition?.preserveOffset()
    publishMetrics()
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if decelerate { source.phaseChanged(.decelerating) } else { scrollingEnded() }
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { scrollingEnded() }
  func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { scrollingEnded() }

  private func scrollingEnded() {
    animatesScroll = false
    applyPreparedRows()
    applyObservedHeights()
    publishMetrics()
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped, source.sendTransition?.isActive != true else { return }
      source.phaseChanged(.idle)
      prefetchNearbyContent()
    }
  }

  private func publishMetrics() {
    guard !stopped, !publishesMetrics else { return }
    publishesMetrics = true
    // Delegate callbacks can also occur during a SwiftUI updateUIViewController pass.
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesMetrics = false
      // A width/font transition can change mounted marker geometry before its
      // measured snapshot commits. Keep the previous reading position until then.
      guard
        displayedRows.isEmpty
          || (displayedWidth == collection.bounds.width
            && displayedCategory == traitCollection.preferredContentSizeCategory)
      else { return }
      let insets = collection.adjustedContentInset
      let metrics = ConversationCollectionMetrics(
        height: collection.contentSize.height, offset: collection.contentOffset.y,
        isNearTop: collection.contentOffset.y + insets.top < 100,
        isAwayFromBottom: collection.contentSize.height + insets.bottom - collection.bounds.maxY
          > 20)
      guard metrics != lastMetrics else { return }
      lastMetrics = metrics
      source.metricsChanged(metrics)
    }
  }

  private func observeHeight(
    _ height: CGFloat, row: ConversationCollectionRow, width: CGFloat,
    category: UIContentSizeCategory, environment: ConversationHeightDiskCache.Layout
  ) {
    guard !stopped, height.isFinite, height > 0, width == collection.bounds.width,
      let measurement = measurements[row.id], measurement.row == row, measurement.width == width,
      measurement.category == category, measurement.environment == environment
    else { return }
    let renderedHeight = pixelHeight(height)
    if abs(measurement.height - renderedHeight) <= 0.5 {
      observedHeights.removeValue(forKey: row.id)
      resizeIDs.removeValue(forKey: row.id)
      resizeTasks.removeValue(forKey: row.id)?.cancel()
      return
    }
    observedHeights[row.id] = ObservedHeight(
      row: row, width: width, category: measurement.category, height: renderedHeight)
    guard resizeTasks[row.id] == nil else { return }
    let generation = UUID()
    resizeIDs[row.id] = generation
    resizeTasks[row.id] = Task { [weak self] in
      guard let self else { return }
      defer {
        if resizeIDs[row.id] == generation {
          resizeTasks[row.id] = nil
          resizeIDs[row.id] = nil
        }
      }
      var previous: CGFloat?
      var stableFrames = 0
      for _ in 0..<30 {
        await conversationLayoutFrame()
        guard !Task.isCancelled, !stopped else { return }
        let current = observedHeights[row.id]?.height
        stableFrames = current == previous ? stableFrames + 1 : 0
        previous = current
        if stableFrames >= 2 { break }
      }
      guard resizeIDs[row.id] == generation, measurements[row.id]?.row == row,
        measurements[row.id]?.width == width
      else { return }
      resizeTasks[row.id] = nil
      applyObservedHeights()
    }
  }

  private func applyObservedHeights() {
    guard !isScrolling, !appliesRows else { return }
    let atBottom =
      source.followsBottom
      || collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 20
    var changed: [String] = []
    var corrected: [ConversationHeightDiskCache.Key: Double] = [:]
    for (id, observed) in observedHeights where resizeTasks[id] == nil {
      if let previous = measurements[id], previous.row == observed.row,
        previous.width == observed.width, previous.category == observed.category,
        abs(previous.height - observed.height) > 0.5
      {
        measurements[id]?.height = observed.height
        if let measurement = measurements[id] {
          source.measurements.store(measurement)
          if let key = measurement.diskKey, key.layout == diskLayout(width: measurement.width) {
            corrected[key] = measurement.height
          }
        }
        changed.append(id)
      }
    }
    guard !changed.isEmpty else { return }
    if !corrected.isEmpty {
      Task { await ConversationHeightDiskCache.shared.store(corrected) }
    }
    source.sendTransition?.prepareForSnapshot()
    // Capture the presented position after pausing any send animation.
    let position = source.anchor.preservedPosition ?? captureReadingPosition()
    if !atBottom, let position { source.anchor.preserve(position) }
    appliesRows = true
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(changed)
    layout.invalidateLayout()
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self, !stopped else { return }
      appliesRows = false
      collection.layoutIfNeeded()
      if isScrolling {
        publishMetrics()
        return
      }
      if source.sendTransition?.isActive == true {
        source.sendTransition?.layoutDidChange()
      } else if atBottom {
        source.anchor.followBottom()
      } else if let position {
        restoreReadingPosition(position)
        source.anchor.restore(position)
      }
      publishMetrics()
      applyPreparedRows()
    }
  }

  @objc private func refreshConversation() {
    guard refreshTask == nil else { return }
    refreshTask = Task { [weak self] in
      guard let self else { return }
      await source.refresh()
      collection.refreshControl?.endRefreshing()
      refreshTask = nil
    }
  }
}

@MainActor
private func conversationLayoutFrame() async {
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

@MainActor
private final class ConversationAccessibilityCollection: UICollectionView {
  var beginsAccessibilityScroll: (() -> Void)?
  override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
    guard isUserInteractionEnabled else { return false }
    guard direction == .up || direction == .down else {
      return super.accessibilityScroll(direction)
    }
    let minimum = -adjustedContentInset.top
    let maximum = max(minimum, contentSize.height - bounds.height + adjustedContentInset.bottom)
    let page = max(1, bounds.height - adjustedContentInset.top - adjustedContentInset.bottom)
    let target = min(maximum, max(minimum, contentOffset.y + (direction == .up ? -page : page)))
    guard abs(target - contentOffset.y) > 0.5 else { return false }
    beginsAccessibilityScroll?()
    setContentOffset(CGPoint(x: contentOffset.x, y: target), animated: true)
    return true
  }
}
