import ChatDomain
import SwiftUI
import Textual

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  let agents: ThreadListStore?
  var didSend: (@MainActor () async -> Void)? = nil
  let mentionSource: ComposerMentionSource?
  let onFirstMessagePresented: (@MainActor (String) -> Void)?
  private var thread: ChatThread { conversation.thread }
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL
  @Environment(\.openChatSource) private var openChatSource
  @State private var scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0
  @State private var activityOwner = UUID()
  @State private var usageDetails: UsageDetails?

  private struct UsageDetails: Identifiable { let id: String }

  init(
    conversation: ConversationStore, agents: ThreadListStore? = nil,
    didSend: (@MainActor () async -> Void)? = nil,
    mentionSource: ComposerMentionSource? = nil,
    onFirstMessagePresented: (@MainActor (String) -> Void)? = nil
  ) {
    self.conversation = conversation
    self.agents = agents
    self.didSend = didSend
    self.mentionSource = mentionSource
    self.onFirstMessagePresented = onFirstMessagePresented
    _scrolling = State(initialValue: ConversationScrollCoordinator(conversation: conversation))
  }

  private var history: ChatHistory { conversation.history ?? .empty }
  private var agentName: String? {
    agents?.agents.first(where: { $0.agentId == thread.agentID })?.displayName
  }
  private var rows: [ConversationCollectionRow] {
    let items = conversation.visibleItems
    var result: [ConversationCollectionRow] = []
    if conversation.hasEarlierMessages {
      result.append(.earlier)
    }
    for (index, item) in items.enumerated() {
      let continuesGroup =
        index > 0 && items[index - 1].role == item.role && !item.beginsWorkSection
        && item.message?.modelChange == nil
        && item.message?.userMessage?.annotation?.type != "automation"
        && items[index - 1].message?.userMessage?.annotation?.type != "automation"
      let spacing: CGFloat = index == 0 ? 20 : (continuesGroup ? 8 : 24)
      switch item {
      case .work(let section, let expanded):
        result.append(
          .work(
            section, expanded: expanded, showsAvatar: true, topSpacing: spacing,
            failed: turnFails(after: index, in: items)))
      case .message(let message, let isWorkHistory):
        if let failure = message.failure {
          // A provider's own error line from the same short run belongs inside the failure
          // card, so the reader sees one explanation instead of two that may disagree.
          var topSpacing = spacing
          var providerMessage: String?
          if case .message(let previous, _, let previousSpacing, _, _, _, _) = result.last,
            isProviderMessage(previous, failure: message, in: items)
          {
            result.removeLast()
            providerMessage = previous.text
            topSpacing = previousSpacing
          }
          result.append(
            .failure(
              message, conversation.failureState(failure), topSpacing: topSpacing,
              providerMessage: providerMessage))
          continue
        }
        let pendingRetry = conversation.pending.first { $0.id == message.id }?.needsRetry
        result.append(
          .message(
            message, showsAvatar: !continuesGroup, topSpacing: spacing,
            pendingRetry: pendingRetry,
            isSending: pendingRetry == true && conversation.isSending, isWorkHistory: isWorkHistory,
            showsActions: !isWorkHistory && pendingRetry == nil && endsTurn(at: index, in: items))
        )
      case .usage(let runID):
        result.append(.usage(runID: runID))
      }
    }
    // Text still streaming from the running run, until its durable event takes the same id.
    for output in conversation.streamedOutputs {
      var continues = false
      if case .message(let previous, _, _, _, _, _, _) = result.last {
        continues = previous.role != .user
      } else if case .work = result.last {
        continues = true
      }
      result.append(
        .message(
          ChatMessage(
            id: output.eventID, role: .assistant, text: output.text, createdAt: output.createdAt,
            runID: output.runID, isQueued: false, isError: false),
          showsAvatar: !continues, topSpacing: continues ? 8 : 24, pendingRetry: nil,
          isSending: false))
    }
    if let source = history.recommendedFollowups, conversation.pending.isEmpty {
      result.append(.followups(source, finishedAt: history.latestRunFinishAt))
    }
    let showsActivityAvatar =
      history.executionState.isActive
      && items.last(where: { $0.message?.isQueued != true })?.role != .assistant
    result.append(.footer(history.executionState, showsAvatar: showsActivityAvatar))
    return result
  }

  /// The last assistant answer of a turn gets the copy / share / open actions.
  private func endsTurn(at index: Int, in items: [ConversationItem]) -> Bool {
    guard let message = items[index].message, message.role == .assistant, !message.isError,
      !message.text.isEmpty
    else { return false }
    var next = index + 1
    while next < items.count {
      switch items[next] {
      case .usage:
        next += 1
      case .work:
        return true
      case .message(let following, let isWorkHistory):
        if isWorkHistory {
          next += 1
          continue
        }
        if following.failure != nil { return false }
        return following.role != .assistant
      }
    }
    return !history.executionState.isActive
  }

  /// A work section whose run ended in a failure (not a user pause) shows a failed header.
  private func turnFails(after index: Int, in items: [ConversationItem]) -> Bool {
    var next = index + 1
    while next < items.count {
      switch items[next] {
      case .work:
        return false
      case .usage:
        next += 1
      case .message(let message, _):
        if message.role == .user { return false }
        if let failure = message.failure {
          return failure.error.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            != "run cancelled"
        }
        next += 1
      }
    }
    return false
  }

  /// The only output of a run that then failed, short and on one line, is the provider's error.
  private func isProviderMessage(
    _ message: ChatMessage, failure: ChatMessage, in items: [ConversationItem]
  ) -> Bool {
    guard message.role == .assistant, message.failure == nil, message.attachments.isEmpty,
      let runID = message.runID, runID == failure.runID,
      message.text.count <= 400, !message.text.contains("\n")
    else { return false }
    for item in items {
      if case .work(let section, _) = item, section.anchorMessageID == message.id {
        return section.stepCount == 0
      }
    }
    return true
  }

  var body: some View {
    let displayedMessages = conversation.visibleMessages
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, renderContext: renderContext,
      measurements: conversation.measurements,
      contentInsets: EdgeInsets(
        top: 0, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor,
      scroll: scrolling.scroll,
      followsBottom: scrolling.followsBottom,
      sendTransition: scrolling.sendTransition,
      isLoadingHistory: conversation.isLoading && conversation.history == nil,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      rowsPresented: { id in
        scrolling.rowsPresented(firstItemID: id)
        if let id { onFirstMessagePresented?(id) }
      },
      earlierMessages: conversation.earlierWindowMessages,
      quote: conversation.quote,
      refresh: {
        await conversation.refresh()
        await conversation.connectorActions.refreshKnown()
      }
    ) { row, anchor in
      rowContent(row, anchor: anchor).environment(\.openURL, openURL)
        .environment(\.openChatSource, openChatSource)
    }
    .ignoresSafeArea(.container, edges: .vertical)
    .overlay {
      if conversation.history == nil && conversation.historySyncError != nil {
        OkouEmptyState(
          "Unable to load chat", icon: "message-circle-warning",
          description: Text("Check your connection and try again. Your draft is still here.")
        ) {
          Button("Try again") { Task { await conversation.refresh() } }
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      }
    }
    .onAppear {
      scrolling.activate(reduceMotion: reduceMotion)
      conversation.setDetailVisible(true, owner: activityOwner)
    }
    .onChange(of: reduceMotion) { _, value in scrolling.setReduceMotion(value) }
    .overlay(alignment: .bottom) {
      ZStack {
        if scrolling.showsBottomButton {
          Button {
            scrolling.jumpToLatest()
          } label: {
            // The same 44 pt glass circle as the header's controls.
            OkouToolbarIcon("arrow-down").modifier(OkouGlassControl(shape: .circle))
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Scroll to bottom")
          .accessibilityIdentifier("scroll-to-bottom")
          .transition(
            reduceMotion ? .opacity : .scale(scale: 0.8).combined(with: .opacity))
        }
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .animation(reduceMotion ? nil : OkouMotion.press, value: scrolling.showsBottomButton)
      .allowsHitTesting(scrolling.showsBottomButton)
      .padding(.bottom, OkouSpace.sm)
    }
    .task(id: displayedMessages.last) { await scrolling.latestMessageChanged() }
    .onChange(of: conversation.visibleItems) { _, _ in scrolling.messagesChanged() }
    .onChange(of: conversation.readingPosition?.messageID) { previousID, id in
      scrolling.readingPositionChanged(previousID: previousID, currentID: id)
    }
    .onChange(of: conversation.navigationRequest) { _, request in
      if let request { scrolling.reveal(request.position) }
    }
    .onDisappear {
      scrolling.deactivate()
      conversation.connectorActions.cancel()
      conversation.setDetailVisible(false, owner: activityOwner)
    }
    .sheet(
      isPresented: Binding(
        get: { conversation.attachmentViewer.preview != nil },
        set: { if !$0 { conversation.attachmentViewer.dismiss() } }
      )
    ) {
      MessageAttachmentPreview(viewer: conversation.attachmentViewer)
    }
    .sheet(
      isPresented: Binding(
        get: { conversation.artifacts.preview != nil },
        set: { if !$0 { conversation.artifacts.dismiss() } }
      )
    ) {
      MessageArtifactPreview(viewer: conversation.artifacts, markdown: conversation.messageMarkdown)
    }
    .onChange(of: history.executionState) { _, _ in scrolling.executionStateChanged() }
    .sheet(item: $usageDetails) { selection in
      ConversationRunUsageDetails(
        usage: conversation.runUsage, runID: selection.id,
        catalog: conversation.modelSelection?.models.usageCatalog,
        retry: { conversation.runUsage.retry(selection.id) }
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
      .okouSheetBackground()
      .task { await conversation.modelSelection?.models.loadUsageCatalog() }
    }
    .sheet(
      item: Binding(
        get: { conversation.connectorActions.active },
        set: { if $0 == nil { conversation.connectorActions.cancel() } }
      )
    ) { flow in
      ConnectorAuthorizationSheet(flow: flow, store: conversation.connectorActions)
        .okouSheetBackground()
    }
    .alert(
      "Unable to open connection",
      isPresented: Binding(
        get: { conversation.connectorActions.activationError != nil },
        set: { if !$0 { conversation.connectorActions.activationError = nil } })
    ) {
      Button("OK") { conversation.connectorActions.activationError = nil }
    } message: {
      Text(conversation.connectorActions.activationError ?? "")
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await conversation.connectorActions.refreshKnown() } }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        if let issue = conversation.stopIssue {
          OkouBanner(Text(issue), icon: "circle-stop") {
            Button("Check status") { Task { await conversation.refresh() } }
              .disabled(conversation.isLoading)
            if conversation.historySyncError == nil && history.canStop {
              Button("Stop again") { Task { await conversation.stop() } }
                .disabled(conversation.isStopping)
            }
          }
          .padding(.horizontal, OkouSpace.lg)
          .padding(.bottom, OkouSpace.xs)
        }
        ChatComposerView(
          draft: $conversation.draft,
          isBusy: conversation.isSending || conversation.isStopping
            || conversation.isRecoveringFailure,
          showsProgress: false, canStop: history.canStop, needsUpgrade: conversation.needsUpgrade,
          error: conversation.error,
          attachmentURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
          attachments: conversation.attachmentDraft,
          draftState: conversation.composer,
          submit: {
            if history.canStop && !conversation.composer.hasContent {
              await conversation.stop()
            } else {
              await scrolling.send()
              await didSend?()
            }
          }, refresh: { await conversation.refresh() }, modelSelection: conversation.modelSelection,
          connectorSelection: conversation.modelSelection?.connectors,
          mentionSource: mentionSource,
          workflowSource: conversation.workflowSource, agentID: conversation.thread.agentID,
          sendTransition: scrolling.sendTransition,
          placeholder: agentName.map { String(localized: "Message \($0)") }
        )
      }
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
    }
    .animation(
      reduceMotion ? nil : .easeInOut(duration: 0.22),
      value: conversation.composer.voice?.phase
    )
    .task(id: thread.id) { await conversation.refresh() }
  }

  private func renderContext(_ message: ChatMessage) -> MessageRenderPlan.Context {
    let assistant = message.role == .assistant
    return .init(
      webURL: conversation.webURL,
      action: assistant ? .init(agentID: thread.agentID, threadID: thread.id) : nil,
      permissionsEnabled: true, artifacts: assistant ? conversation.artifacts : nil)
  }

  @ViewBuilder
  private func rowContent(_ row: ConversationCollectionRow, anchor: ConversationScrollAnchor?)
    -> some View
  {
    switch row {
    case .failure(let message, let state, let topSpacing, let providerMessage):
      AssistantFailureCard(
        state: state, conversation: conversation, providerMessage: providerMessage
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .followups(let source, let finishedAt):
      RecommendedFollowupList(
        source: source, finishedAt: finishedAt,
        select: conversation.composer.editor.selectOrAppendText
      )
      .padding(.top, OkouSpace.xxl)
    case .earlier:
      ConversationEarlierMessagesButton(conversation: conversation, scrolling: scrolling)
    case .work(let section, let expanded, let showsAvatar, let topSpacing, let failed):
      // The avatar shares the work summary's line instead of taking a line of its own.
      HStack(spacing: OkouSpace.sm) {
        if showsAvatar { assistantAvatar }
        ConversationWorkHeader(section: section, expanded: expanded, failed: failed) {
          scrolling.toggleWorkHistory(section.id)
        }
      }
      .padding(.leading, showsAvatar ? 0 : OkouSpace.six)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: section.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .message(
      let message, let showsAvatar, let topSpacing, let pendingRetry, let isSending,
      let isWorkHistory, let showsActions):
      messageRow(
        message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
        isWorkHistory: isWorkHistory, showsActions: showsActions, loadsAttachments: anchor != nil
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(
        EdgeInsets(
          top: topSpacing, leading: ConversationCollectionRow.messageHorizontalInset,
          bottom: 0, trailing: ConversationCollectionRow.messageHorizontalInset))
    case .footer(let executionState, let showsAvatar):
      VStack(alignment: .leading, spacing: OkouSpace.xxl) {
        if executionState.isActive {
          HStack(spacing: OkouSpace.sm) {
            if showsAvatar { assistantAvatar }
            ConversationActivityLabel(
              summary: conversation.activitySummary, state: executionState
            )
          }
          .padding(.leading, showsAvatar ? 0 : OkouSpace.six)
        }
        Color.clear.frame(height: 1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(EdgeInsets(top: 24, leading: 20, bottom: 20, trailing: 20))
    case .usage(let runID):
      ConversationRunUsageView(
        runID: runID, usage: conversation.runUsage,
        showDetails: { usageDetails = UsageDetails(id: runID) }
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: "usage:\(runID)", anchor: anchor) }
      }
      .padding(.horizontal, 26)
    }
  }

  private func messageRow(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool, showsActions: Bool, loadsAttachments: Bool
  ) -> some View {
    Group {
      if message.role == .user {
        VStack(alignment: .trailing, spacing: OkouSpace.sm) {
          if let change = message.modelChange {
            modelChangeLabel(change)
          }
          UserMessageView(
            message: message, webURL: conversation.webURL,
            viewer: conversation.attachmentViewer, loadsAttachments: loadsAttachments,
            sendTransition: loadsAttachments ? scrolling.sendTransition : nil)
          deliveryStatus(message, pendingRetry: pendingRetry, isSending: isSending)
        }
      } else {
        messageContent(
          message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
          isWorkHistory: isWorkHistory, showsActions: showsActions,
          loadsAttachments: loadsAttachments
        )
        .textual.fontScale(isWorkHistory ? 0.9 : 1)
        .foregroundStyle(isWorkHistory ? OkouColor.mutedForeground : OkouColor.foreground)
        .padding(.leading, isWorkHistory ? 28 : 0)
        .overlay(alignment: .leading) {
          if isWorkHistory {
            Rectangle().fill(OkouColor.divider).frame(width: 1).padding(
              .leading, 14)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
  }

  private var assistantAvatar: some View {
    ChatAgentAvatar(agents: agents, agentID: thread.agentID)
      .accessibilityIdentifier("assistant-avatar")
  }

  private func messageContent(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool = false, showsActions: Bool = false, loadsAttachments: Bool = false
  ) -> some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if message.role == .assistant && showsAvatar { assistantAvatar }
      if message.role == .system {
        Label(message.text, okouSymbol: message.isError ? "circle-alert" : "circle-stop")
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .textSelection(.enabled)
          .padding(.leading, OkouSpace.six)
      } else if !message.text.isEmpty {
        MessageBodyView(
          text: message.text, baseURL: conversation.webURL, markdown: conversation.messageMarkdown,
          actionContext: message.role == .assistant
            ? MessageActionContext(agentID: thread.agentID, threadID: thread.id) : nil,
          connectorActions: conversation.connectorActions,
          permissionActions: conversation.permissionActions,
          approvals: message.role == .assistant ? conversation.approvals : nil,
          artifacts: message.role == .assistant ? conversation.artifacts : nil,
          artifactImageSources: conversation.artifactImageSources(for: message.id),
          loadsActions: loadsAttachments, loadsDiagrams: loadsAttachments
        )
        .equatable()
        .foregroundStyle(isWorkHistory ? OkouColor.mutedForeground : OkouColor.foreground)
        .padding(
          .leading, message.role == .assistant ? ConversationCollectionRow.assistantLeadingInset : 0
        )
      }
      ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, attachment in
        MessageAttachmentView(
          attachment: attachment, viewer: conversation.attachmentViewer,
          loadsThumbnail: loadsAttachments)
      }
      deliveryStatus(message, pendingRetry: pendingRetry, isSending: isSending)
      if showsActions {
        MessageActionBar(
          text: message.copyText,
          chatURL: conversation.webURL.appending(path: "chats/\(thread.id)"),
          shareLink: { audience in
            let id = try await conversation.shareAnswer(message.id, audience: audience)
            return conversation.webURL.appending(path: "share/threads/\(id)")
          }
        )
        // The answer's text is inset 6 pt; the first glyph sits on that edge.
        .padding(.leading, OkouSpace.six)
      }
    }
  }

  @ViewBuilder
  private func deliveryStatus(_ message: ChatMessage, pendingRetry: Bool?, isSending: Bool)
    -> some View
  {
    if let pendingRetry {
      HStack {
        Text(pendingRetry ? conversation.deliveryFailureText(message.id) : "Sending…")
          .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
        if pendingRetry {
          Button("Check and retry") {
            guard let pending = conversation.pending.first(where: { $0.id == message.id }) else {
              return
            }
            Task { await conversation.retry(pending) }
          }
          .font(.okou(.caption))
          .disabled(isSending)
        }
      }
    }
  }

  private func modelChangeLabel(_ change: ChatModelChange) -> some View {
    let label: String
    switch change {
    case .model(let model):
      let name =
        conversation.modelSelection?.models.configuration?.catalog.name(model.id) ?? model.id
      label = "Model: \(name)" + (model.isFast ? " · Fast" : "")
    case .fastMode(let enabled): label = enabled ? "Fast mode on" : "Fast mode off"
    }
    return Label(label, okouSymbol: "sliders-horizontal", iconSize: OkouIconSize.inline)
      .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .trailing)
  }

}

private struct ConversationEarlierMessagesButton: View {
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator

  var body: some View {
    // Update the mounted indicator without waiting for the next measured snapshot.
    let isLoading = scrolling.isLoadingEarlier || conversation.isLoadingEarlier
    Button {
      scrolling.loadEarlierMessages()
    } label: {
      ProgressView()
        .controlSize(.small)
        .opacity(isLoading ? 1 : 0)
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(isLoading)
    .accessibilityLabel(isLoading ? "Loading earlier messages" : "Load earlier messages")
    .accessibilityIdentifier("load-earlier-messages")
    .padding(.horizontal, OkouSpace.xl)
  }
}
