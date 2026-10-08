import SwiftUI

/// Presentation revisions include every input that can change a row's measured size.
enum ConversationCollectionRow: Equatable, Identifiable {
  case earlier(isLoading: Bool)
  case message(
    ChatMessage, showsAvatar: Bool, topSpacing: CGFloat, pendingRetry: Bool?, isSending: Bool)
  case footer(ChatExecutionState, hasMessages: Bool)

  var id: String {
    switch self {
    case .earlier: "conversation-earlier"
    case .message(let message, _, _, _, _): message.id
    case .footer: "conversation-bottom"
    }
  }

  var message: ChatMessage? {
    if case .message(let message, _, _, _, _) = self { return message }
    return nil
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
  let anchor: ConversationScrollAnchor
  let scroll: ConversationCollectionScroll
  let followsBottom: Bool
  let phaseChanged: (ScrollPhase) -> Void
  let metricsChanged: (ConversationCollectionMetrics) -> Void
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
  UICollectionViewDelegateFlowLayout, ConversationCollectionScrolling
{
  private struct Measurement: Equatable {
    let row: ConversationCollectionRow
    let width: CGFloat
    let category: UIContentSizeCategory
    var height: CGFloat
  }

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

  private let layout = UICollectionViewFlowLayout()
  private var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var source: ConversationCollectionView<Content>
  private var measurements: [String: Measurement] = [:]
  private var displayedRows: [String: ConversationCollectionRow] = [:]
  private var displayedWidth: CGFloat = 0
  private var displayedCategory = UIContentSizeCategory.unspecified
  private var preparation: Task<Void, Never>?
  private var preparationID = UUID()
  private var requestedRows: [ConversationCollectionRow] = []
  private var requestedWidth: CGFloat = 0
  private var requestedCategory = UIContentSizeCategory.unspecified
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

  init(source: ConversationCollectionView<Content>) {
    self.source = source
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
    collection.keyboardDismissMode = .interactive
    collection.selfSizingInvalidation = .disabled
    collection.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "message")
    collection.delegate = self
    (collection as? ConversationAccessibilityCollection)?.beginsAccessibilityScroll = {
      [weak self] in
      guard let self else { return }
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
      let cell = collection.dequeueReusableCell(withReuseIdentifier: "message", for: index)
      guard let row = self.displayedRows[id], let measurement = self.measurements[id] else {
        preconditionFailure("Every displayed conversation row must have a measurement")
      }
      cell.clipsToBounds = true
      let content = self.source.content(row, self.source.anchor)
      cell.contentConfiguration = UIHostingConfiguration {
        content
          .fixedSize(horizontal: false, vertical: true)
          .onGeometryChange(for: CGFloat.self) {
            $0.size.height
          } action: { [weak self] height in
            self?.observeHeight(
              height, row: row, width: measurement.width, category: measurement.category)
          }
          .frame(height: measurement.height, alignment: .topLeading)
      }.margins(.all, 0)
      return cell
    }
    source.anchor.isPresentedMarker = { [weak self] marker in
      self?.isPresentedMarker(marker) ?? false
    }
    loading.hidesWhenStopped = true
    view.addSubview(loading)
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
      (controller: ConversationCollectionController<Content>, _: UITraitCollection) in
      controller.publishViewportChange()
      controller.prepareRowsIfNeeded()
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    loading.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    if collection.bounds.size != lastViewportSize {
      lastViewportSize = collection.bounds.size
      publishViewportChange()
    }
    prepareRowsIfNeeded()
    publishMetrics()
  }

  override func viewSafeAreaInsetsDidChange() {
    super.viewSafeAreaInsetsDidChange()
    publishViewportChange()
    publishMetrics()
  }

  private func publishViewportChange() {
    guard !publishesViewport else { return }
    publishesViewport = true
    source.anchor.layoutDidChange()
    DispatchQueue.main.async { [weak self] in
      guard let self, !stopped else { return }
      publishesViewport = false
      if !isScrolling { source.anchor.viewportDidChange?() }
    }
  }

  func update(_ source: ConversationCollectionView<Content>) {
    self.source = source
    if isViewLoaded { prepareRowsIfNeeded() }
  }

  func stop() {
    stopped = true
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
        return marker.convert(marker.bounds, to: cell).intersects(cell.bounds)
      }
      ancestor = view.superview
    }
    return false
  }

  private func prepareRowsIfNeeded() {
    guard !stopped, collection.bounds.width > 0 else { return }
    let width = collection.bounds.width
    let category = traitCollection.preferredContentSizeCategory
    guard requestedRows != source.rows || requestedWidth != width || requestedCategory != category
    else { return }
    requestedRows = source.rows
    requestedWidth = width
    requestedCategory = category
    preparation?.cancel()
    let generation = UUID()
    preparationID = generation
    preparedRows = nil
    let rows = source.rows
    let missing = rows.filter {
      guard let measured = measurements[$0.id] else { return true }
      return measured.row != $0 || measured.width != width || measured.category != category
    }
    let validIDs = Set(rows.map(\.id)).subtracting(missing.map(\.id))
    for id in resizeTasks.keys where !validIDs.contains(id) {
      resizeTasks.removeValue(forKey: id)?.cancel()
      resizeIDs.removeValue(forKey: id)
    }
    observedHeights = observedHeights.filter { validIDs.contains($0.key) }
    var preparedMeasurements = measurements.filter { validIDs.contains($0.key) }
    if displayedRows.isEmpty && rows.contains(where: { $0.message != nil }) {
      loading.startAnimating()
    }
    preparation = Task { [weak self] in
      guard let self else { return }
      // Four temporary hosts at a time bound retained views even in an expanded history.
      for start in stride(from: 0, to: missing.count, by: 4) {
        let batch = Array(missing[start..<min(start + 4, missing.count)])
        for row in batch {
          if let message = row.message { _ = await source.markdown.content(for: message.text) }
          guard !Task.isCancelled, preparationID == generation else { return }
        }
        let heights = await measure(batch, width: width)
        guard !Task.isCancelled, preparationID == generation else { return }
        for (row, height) in zip(batch, heights) {
          preparedMeasurements[row.id] = Measurement(
            row: row, width: width, category: category, height: height)
        }
      }
      guard !Task.isCancelled, preparationID == generation, !stopped else { return }
      preparation = nil
      preparedRows = PreparedRows(rows: rows, measurements: preparedMeasurements)
      applyPreparedRows()
    }
  }

  private func measure(_ rows: [ConversationCollectionRow], width: CGFloat) async -> [CGFloat] {
    let hosts = rows.map { row in
      let host = UIHostingController(
        rootView: source.content(row, nil).fixedSize(horizontal: false, vertical: true)
          .ignoresSafeArea())
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
      await conversationLayoutFrame()
      guard !Task.isCancelled else { return previous }
      let heights = hosts.map { host in
        let size = host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
        let height = pixelHeight(size.height)
        host.view.frame.size.height = height
        host.view.layoutIfNeeded()
        return height
      }
      stableFrames = heights == previous ? stableFrames + 1 : 0
      previous = heights
      if stableFrames >= 2 { break }
    }
    return previous
  }

  private func pixelHeight(_ height: CGFloat) -> CGFloat {
    let scale = traitCollection.displayScale
    return max(1, ceil(height * scale) / scale)
  }

  private var isScrolling: Bool {
    animatesScroll || collection.isTracking || collection.isDragging || collection.isDecelerating
  }

  private func applyPreparedRows() {
    guard let prepared = preparedRows, !isScrolling, !appliesRows else { return }
    preparedRows = nil
    appliesRows = true
    let rows = prepared.rows
    let position = source.anchor.preservedPosition ?? source.anchor.capture()
    let oldIDs = Set(dataSource.snapshot().itemIdentifiers)
    var updatedMeasurements = prepared.measurements
    for row in rows {
      if let current = measurements[row.id], let prepared = updatedMeasurements[row.id],
        current.row == prepared.row, current.width == prepared.width,
        current.category == prepared.category
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
    displayedWidth = requestedWidth
    displayedCategory = requestedCategory
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(rows.map(\.id))
    snapshot.reconfigureItems(changed)
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self, !stopped else { return }
      appliesRows = false
      let ids = Set(dataSource.snapshot().itemIdentifiers)
      displayedRows = displayedRows.filter { ids.contains($0.key) }
      measurements = measurements.filter { ids.contains($0.key) }
      collection.layoutIfNeeded()
      loading.stopAnimating()
      if isScrolling {
        publishMetrics()
        return
      }
      if let pendingScroll {
        self.pendingScroll = nil
        scrollTo(pendingScroll.0, anchor: pendingScroll.1, animated: pendingScroll.2)
      } else if source.followsBottom {
        source.anchor.followBottom()
        scrollTo("conversation-bottom", anchor: .bottom, animated: false)
      } else if let position, ids.contains(position.messageID) {
        source.anchor.restore(position)
      }
      source.anchor.layoutDidChange()
      publishMetrics()
      applyPreparedRows()
      applyObservedHeights()
    }
  }

  func scrollTo(_ id: String, anchor: UnitPoint, animated: Bool) {
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
    pendingScroll = nil
    animatesScroll = false
    source.phaseChanged(.interacting)
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { publishMetrics() }

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
      guard let self, !stopped else { return }
      source.phaseChanged(.idle)
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
    category: UIContentSizeCategory
  ) {
    guard !stopped, height.isFinite, height > 0, width == collection.bounds.width,
      let measurement = measurements[row.id], measurement.row == row, measurement.width == width,
      measurement.category == category
    else { return }
    observedHeights[row.id] = ObservedHeight(
      row: row, width: width, category: measurement.category, height: pixelHeight(height))
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
    // A width/font snapshot can still be restoring its anchor when a mounted
    // Markdown view acquires its final height. Keep that intended position.
    let position = source.anchor.preservedPosition ?? source.anchor.capture()
    let atBottom =
      source.followsBottom
      || collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 20
    var changed: [String] = []
    for (id, observed) in observedHeights where resizeTasks[id] == nil {
      if let previous = measurements[id], previous.row == observed.row,
        previous.width == observed.width, previous.category == observed.category,
        abs(previous.height - observed.height) > 0.5
      {
        measurements[id]?.height = observed.height
        changed.append(id)
      }
    }
    guard !changed.isEmpty else { return }
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
      if atBottom {
        source.anchor.followBottom()
      } else if let position {
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
