import ChatDomain
import SwiftUI
import Textual

struct ChatDetailView: View {
  @Bindable var conversation: ConversationStore
  let topContentInset: CGFloat
  let sidebar: SidebarInteraction?
  let mentionSource: ComposerMentionSource?
  private var thread: ChatThread { conversation.thread }
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openURL) private var openURL
  @Environment(\.openChatSource) private var openChatSource
  @State private var scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0
  @State private var activityOwner = UUID()
  @State private var messageToSelect: ChatMessage?
  @State private var usageDetails: UsageDetails?
  @State private var selectionToQuote: ChatFeedbackSelection?

  private struct UsageDetails: Identifiable { let id: String }

  init(
    conversation: ConversationStore, topContentInset: CGFloat = 0,
    sidebar: SidebarInteraction? = nil, mentionSource: ComposerMentionSource? = nil
  ) {
    self.conversation = conversation
    self.topContentInset = topContentInset
    self.sidebar = sidebar
    self.mentionSource = mentionSource
    _scrolling = State(initialValue: ConversationScrollCoordinator(conversation: conversation))
  }

  private var history: ChatHistory { conversation.history ?? .empty }
  private var rows: [ConversationCollectionRow] {
    let items = conversation.visibleItems
    var result: [ConversationCollectionRow] = []
    if conversation.hasEarlierMessages {
      result.append(.earlier(isLoading: conversation.isLoadingEarlier))
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
          .work(section, expanded: expanded, showsAvatar: true, topSpacing: spacing))
      case .message(let message, let isWorkHistory):
        if let failure = message.failure {
          result.append(.failure(message, conversation.failureState(failure), topSpacing: spacing))
          continue
        }
        let pendingRetry = conversation.pending.first { $0.id == message.id }?.needsRetry
        result.append(
          .message(
            message, showsAvatar: !continuesGroup, topSpacing: spacing,
            pendingRetry: pendingRetry,
            isSending: pendingRetry == true && conversation.isSending, isWorkHistory: isWorkHistory)
        )
      case .usage(let runID):
        result.append(.usage(runID: runID, state: conversation.runUsage.states[runID] ?? .loading))
      }
    }
    if let source = history.recommendedFollowups, conversation.pending.isEmpty {
      result.append(.followups(source, finishedAt: history.latestRunFinishAt))
    }
    result.append(.footer(history.executionState))
    return result
  }

  var body: some View {
    let displayedMessages = conversation.visibleMessages
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, measurements: conversation.measurements,
      contentInsets: EdgeInsets(
        top: topContentInset, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor,
      scroll: scrolling.scroll,
      followsBottom: scrolling.followsBottom, sidebar: sidebar,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      refresh: {
        await conversation.refresh()
        await conversation.connectorActions.refreshKnown()
      }
    ) { row, anchor in
      rowContent(row, anchor: anchor).environment(\.openURL, openURL)
        .environment(\.openChatSource, openChatSource)
    }
    .ignoresSafeArea(.container, edges: .vertical)
    .onAppear {
      scrolling.activate(reduceMotion: reduceMotion)
      conversation.setDetailVisible(true, owner: activityOwner)
    }
    .onChange(of: reduceMotion) { _, value in scrolling.setReduceMotion(value) }
    .overlay(alignment: .bottom) {
      if scrolling.showsBottomButton {
        Button {
          scrolling.jumpToLatest()
        } label: {
          Image(systemName: "arrow.down").font(.system(size: 18, weight: .medium))
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .controlSize(.large)
        .accessibilityLabel("Scroll to bottom")
        .accessibilityIdentifier("scroll-to-bottom")
        .padding(.bottom, 16)
      }
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
      selectionToQuote = nil
      messageToSelect = nil
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
      item: $messageToSelect,
      onDismiss: {
        if let selection = selectionToQuote { conversation.quote(selection) }
        selectionToQuote = nil
      }
    ) { message in
      MessageTextSelectionSheet(
        text: message.copyText, message: message,
        quote: message.role == .assistant
          ? { selection in
            selectionToQuote = selection
            messageToSelect = nil
          } : nil)
    }
    .onChange(of: history.executionState) { _, _ in scrolling.executionStateChanged() }
    .sheet(item: $usageDetails) { selection in
      ConversationRunUsageDetails(
        state: conversation.runUsage.states[selection.id] ?? .loading,
        catalog: conversation.modelSelection?.models.usageCatalog,
        retry: { conversation.runUsage.retry(selection.id) }
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
      .task { await conversation.modelSelection?.models.loadUsageCatalog() }
    }
    .sheet(
      item: Binding(
        get: { conversation.connectorActions.active },
        set: { if $0 == nil { conversation.connectorActions.cancel() } }
      )
    ) { flow in
      ConnectorAuthorizationSheet(flow: flow, store: conversation.connectorActions)
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { Task { await conversation.connectorActions.refreshKnown() } }
    }
    .safeAreaBar(edge: .bottom, spacing: 0) {
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
            await conversation.send()
          }
        }, refresh: { await conversation.refresh() }, modelSelection: conversation.modelSelection,
        mentionSource: mentionSource,
        workflowSource: conversation.workflowSource, agentID: conversation.thread.agentID
      )
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
    }
    .task(id: thread.id) { await conversation.refresh() }
    .overlay {
      if conversation.isLoading && conversation.history == nil {
        ConversationLoadingView()
      }
    }
  }

  @ViewBuilder
  private func rowContent(_ row: ConversationCollectionRow, anchor: ConversationScrollAnchor?)
    -> some View
  {
    switch row {
    case .failure(let message, let state, let topSpacing):
      AssistantFailureCard(state: state, conversation: conversation)
        .background {
          if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
        }
        .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .followups(let source, let finishedAt):
      RecommendedFollowupList(
        source: source, finishedAt: finishedAt,
        select: conversation.composer.editor.selectOrAppendText
      )
      .padding(EdgeInsets(top: 24, leading: 26, bottom: 0, trailing: 20))
    case .earlier(let isLoading):
      Button {
        scrolling.loadEarlierMessages()
      } label: {
        HStack {
          Spacer()
          if isLoading { ProgressView().controlSize(.small) }
          Text("Load earlier messages")
          Spacer()
        }
      }
      .disabled(isLoading)
      .accessibilityIdentifier("load-earlier-messages")
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
    case .work(let section, let expanded, let showsAvatar, let topSpacing):
      VStack(alignment: .leading, spacing: 8) {
        if showsAvatar { assistantAvatar }
        ConversationWorkHeader(section: section, expanded: expanded) {
          scrolling.toggleWorkHistory(section.id)
        }
        .padding(.leading, 6)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if let anchor { ConversationRowAnchor(messageID: section.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .message(
      let message, let showsAvatar, let topSpacing, let pendingRetry, let isSending,
      let isWorkHistory):
      messageRow(
        message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
        isWorkHistory: isWorkHistory, loadsAttachments: anchor != nil
      )
      .background {
        if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
      }
      .padding(EdgeInsets(top: topSpacing, leading: 20, bottom: 0, trailing: 20))
    case .footer(let executionState):
      VStack(alignment: .leading, spacing: 24) {
        if executionState.isActive {
          ConversationActivityLabel(
            summary: conversation.activitySummary, state: executionState)
        }
        Color.clear.frame(height: 1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(EdgeInsets(top: 24, leading: 20, bottom: 20, trailing: 20))
    case .usage(let runID, let state):
      ConversationRunUsageView(
        runID: runID, state: state, showDetails: { usageDetails = UsageDetails(id: runID) }
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
    isWorkHistory: Bool, loadsAttachments: Bool
  ) -> some View {
    Group {
      if message.role == .user {
        VStack(alignment: .trailing, spacing: 8) {
          if let change = message.modelChange {
            modelChangeLabel(change)
          }
          UserMessageView(
            message: message, webURL: conversation.webURL,
            viewer: conversation.attachmentViewer, loadsAttachments: loadsAttachments)
          deliveryStatus(message, pendingRetry: pendingRetry, isSending: isSending)
        }
      } else {
        messageContent(
          message, showsAvatar: showsAvatar, pendingRetry: pendingRetry, isSending: isSending,
          isWorkHistory: isWorkHistory, loadsAttachments: loadsAttachments
        )
        .textual.fontScale(isWorkHistory ? 0.9 : 1)
        .foregroundStyle(isWorkHistory ? Color.secondary : Color.primary)
        .padding(.leading, isWorkHistory ? 28 : 0)
        .overlay(alignment: .leading) {
          if isWorkHistory {
            Rectangle().fill(Color.secondary.opacity(0.25)).frame(width: 1).padding(.leading, 14)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    .contextMenu {
      if !message.copyText.isEmpty {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.copyText }
        Button("Select Text", systemImage: "text.cursor") { messageToSelect = message }
      }
    }
  }

  private var assistantAvatar: some View {
    Image("AssistantAvatar")
      .resizable().scaledToFit()
      .frame(width: 28, height: 28)
      .accessibilityLabel("Okou")
      .accessibilityIdentifier("assistant-avatar")
  }

  private func messageContent(
    _ message: ChatMessage, showsAvatar: Bool, pendingRetry: Bool?, isSending: Bool,
    isWorkHistory: Bool = false, loadsAttachments: Bool = false
  ) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if message.role == .assistant && showsAvatar { assistantAvatar }
      if message.role == .system {
        Label(message.text, systemImage: message.isError ? "exclamationmark.circle" : "stop.circle")
          .font(.subheadline)
          .foregroundStyle(message.isError ? Color.red : Color.secondary)
          .textSelection(.enabled)
          .padding(.leading, 6)
      } else if !message.text.isEmpty {
        MessageBodyView(
          text: message.text, baseURL: conversation.webURL, markdown: conversation.messageMarkdown,
          actionContext: message.role == .assistant
            ? MessageActionContext(agentID: thread.agentID, threadID: thread.id) : nil,
          connectorActions: conversation.connectorActions,
          permissionActions: conversation.permissionActions, loadsActions: loadsAttachments
        )
        .equatable()
        .foregroundStyle(
          message.isError ? Color.red : (isWorkHistory ? Color.secondary : Color.primary)
        )
        .padding(.leading, message.role == .assistant ? 6 : 0)
      }
      ForEach(Array(message.attachments.enumerated()), id: \.offset) { _, attachment in
        MessageAttachmentView(
          attachment: attachment, viewer: conversation.attachmentViewer,
          loadsThumbnail: loadsAttachments)
      }
      deliveryStatus(message, pendingRetry: pendingRetry, isSending: isSending)
    }
  }

  @ViewBuilder
  private func deliveryStatus(_ message: ChatMessage, pendingRetry: Bool?, isSending: Bool)
    -> some View
  {
    if let pendingRetry {
      HStack {
        Text(pendingRetry ? "Delivery not confirmed" : "Sending…")
          .font(.caption).foregroundStyle(.secondary)
        if pendingRetry {
          Button("Check and retry") {
            guard let pending = conversation.pending.first(where: { $0.id == message.id }) else {
              return
            }
            Task { await conversation.retry(pending) }
          }
          .font(.caption)
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
    return Label(label, systemImage: "slider.horizontal.3")
      .font(.caption).foregroundStyle(.secondary).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .trailing)
  }

}
