import ChatData
import ChatDomain
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ChatComposerView: View {
  @Binding var draft: String
  let isBusy: Bool
  let showsProgress: Bool
  let canStop: Bool
  let needsUpgrade: Bool
  let error: String?
  let attachmentURL: URL
  let attachments: AttachmentDraftStore
  var draftState: ComposerDraftStore? = nil
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  var modelSelection: ChatModelSelectionStore? = nil
  var connectorSelection: ComposerConnectorStore? = nil
  var mentionSource: ComposerMentionSource? = nil
  var workflowSource: ComposerWorkflowSource? = nil
  var agentID: String? = nil
  var sendTransition: ConversationSendTransition? = nil
  /// "Message <agent>", so the field names who will do the work.
  var placeholder: String? = nil
  var project: ChatProject? = nil
  var removeProject: (() -> Void)? = nil

  @State private var isFocused = false
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var showsConnectors = false
  @State private var showsModels = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var showsCamera = false
  @State private var showsAddSheet = false
  /// What "Add to chat" asked for; the composer opens it once the sheet has gone.
  @State private var pendingAdd: ComposerAddAction?
  @State private var showsScanner = false
  @State private var sendFeedback = 0
  @State private var stopFeedback = 0
  @State private var mountedVoice: ComposerVoiceInputStore?
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.newChatActivation) private var newChatActivation
  private let actionSize = OkouControl.minimumTarget

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var hasContent: Bool {
    hasText || attachments.hasAttachments || draftState?.hasContent == true
  }
  /// A draft keeps the open layout after the keyboard closes; collapsing it cut the text to
  /// one truncated line under the controls. Voice input opens it too, and the model sheet
  /// keeps it open while the keyboard is down under the sheet.
  private var expandsInput: Bool {
    isFocused || hasText || draftState?.document.hasFeedback == true
      || draftState?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
      || voiceActive || showsModels
  }
  private var showsStop: Bool { canStop && !hasContent }
  private var voiceActive: Bool {
    guard let voice = draftState?.voice else { return false }
    return voice.phase == .recording || voice.phase == .processing || voice.phase == .saved
  }
  /// Expanded text entry reserves send before typing; only compact or voice-only input lets
  /// the mic take its place, so the toolbar does not reflow on the first or last character.
  private var replacesSendWithMic: Bool {
    !hasContent && !canStop && draftState?.voice != nil && (!expandsInput || voiceActive)
  }
  private var showsModelPicker: Bool { expandsInput && !voiceActive }
  private var showsVoiceInput: Bool {
    replacesSendWithMic || (expandsInput && !voiceActive)
  }
  private var resolvedPlaceholder: String { placeholder ?? String(localized: "Message Okou") }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      if let project {
        OkouBanner(Text(verbatim: project.name), icon: "folder", dismiss: removeProject)
          .accessibilityLabel("Project: \(project.name)")
          .disabled(isBusy || needsUpgrade)
      }
      if let voice = draftState?.voice, voice.error != nil || voiceActive {
        ComposerVoiceInputTray(voice: voice)
          .transition(reduceMotion ? .identity : .move(edge: .bottom).combined(with: .opacity))
      }
      // Every notice above the composer is the same quiet banner (OkouBanner): one footnote
      // sentence, its actions as text buttons, a ✕ where the reader can dismiss it.
      if let state = draftState {
        if !state.document.isSupported {
          OkouBanner(
            Text("This draft contains content this app cannot edit. Open it on the web."),
            icon: "file-warning", tone: .problem
          ) {
            Link("Open on web", destination: attachmentURL)
          }
        }
        let contextLabels = ChatDraftDocument(
          parts: state.document.parts.filter { !ComposerAttributedDocument.isInline($0) }
        ).contextLabels
        if !contextLabels.isEmpty {
          Text(contextLabels.joined(separator: " · "))
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground).lineLimit(3)
            .padding(.horizontal, OkouSpace.md)
            .accessibilityLabel("Saved context: " + contextLabels.joined(separator: ", "))
        }
        if let draftError = state.error,
          state.document.isSupported || state.hasLocalFailure || state.conflictingRemote != nil
        {
          OkouBanner(Text(draftError), icon: "circle-alert", tone: .problem) {
            if state.conflictingRemote != nil {
              Button("Keep this draft") { state.keepLocal() }
              Button("Use other device's draft") { state.useRemote() }
            } else if state.hasLocalFailure {
              Button("Copy draft text") { UIPasteboard.general.string = state.text }
                .disabled(state.text.isEmpty)
              Button("Save on this device") { state.retryLocalSave() }
                .disabled(!state.canRetryLocalSave)
            } else {
              Button("Retry draft sync") { Task { await state.synchronize() } }
            }
          }
        }
      }
      if let state = draftState, let warning = state.syncWarning {
        OkouBanner(Text(warning), icon: "refresh-cw") {
          Button("Sync draft") { Task { await state.synchronize() } }
        }
      }
      if !attachments.items.isEmpty {
        ChatAttachmentChips(draft: attachments, isDisabled: isBusy || needsUpgrade)
      }
      if attachments.importingCount > 0 {
        OkouLoadingRow("Preparing attachments…")
          .padding(.horizontal, OkouSpace.md)
      }
      if let importError = attachments.error {
        OkouBanner(
          Text(importError), icon: "circle-alert", tone: .problem,
          dismiss: { attachments.error = nil })
      }
      if let error {
        OkouBanner(Text(error), icon: "circle-alert", tone: .problem) {
          if let refresh {
            Button("Refresh") { Task { await refresh() } }
            Link("Open on web", destination: attachmentURL)
          }
        }
      }

      let inputID = attachments.inputID
      // Retired native editors must leave immediately. Fading a first responder
      // through a draft reset can restart keyboard avoidance during the send flight.
      OkouComposerSurface(isExpanded: expandsInput) {
        Group {
          if let state = draftState {
            ChatFeedbackComposer(
              state: state, inputID: inputID, isFocused: $isFocused,
              acceptsImages: !isBusy && !needsUpgrade, placeholder: resolvedPlaceholder
            )
            .id(inputID)
            .transition(.identity)
            .disabled(!state.document.isSupported)
          } else {
            ChatComposerTextInput(
              text: $draft, isFocused: $isFocused,
              acceptsImages: !isBusy && !needsUpgrade,
              isCurrent: { attachments.inputID == inputID },
              pasteImages: attachments.importPastedImages,
              placeholder: resolvedPlaceholder
            )
            .id(inputID)
            .transition(.identity)
          }
        }
        .accessibilityIdentifier("message-input")
      } leading: {
        HStack(spacing: 0) {
          Button {
            showsAddSheet = true
          } label: {
            OkouToolbarIcon("plus")
              .frame(width: actionSize, height: actionSize)
              .overlay(alignment: .topTrailing) {
                if connectorSelection?.uncertain == true {
                  OkouIcon("circle-alert", size: OkouIconSize.badge)
                    .foregroundStyle(OkouStatusColor.warning)
                }
              }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Add attachments and tools")
          .accessibilityValue(
            connectorSelection?.uncertain == true ? "Confirm connector settings before sending" : ""
          )
          .disabled(isBusy || needsUpgrade)
        }
      } trailing: {
        HStack(spacing: OkouSpace.xs) {
          // The chat's model, only while the composer is open, where the next message is written.
          // Keep controls mounted so they enter with the moving toolbar, not at its final position.
          if let modelSelection {
            ChatModelPickerButton(selection: modelSelection, action: { showsModels = true })
              .disabled(needsUpgrade)
              .opacity(showsModelPicker ? 1 : 0)
              .allowsHitTesting(showsModelPicker)
              .accessibilityHidden(!showsModelPicker)
          }
          // The mic and send are already side by side when the text editor opens.
          if let voice = draftState?.voice {
            ComposerVoiceInputButton(voice: voice)
              .disabled(isBusy || needsUpgrade || voiceActive || draftState?.canEditVoice != true)
              .opacity(showsVoiceInput ? 1 : 0)
              .allowsHitTesting(showsVoiceInput)
              .accessibilityHidden(!showsVoiceInput)
          }
          if !replacesSendWithMic {
            Button {
              if showsStop { stopFeedback += 1 } else { sendFeedback += 1 }
              // The send operation captures native text for motion before ending editing.
              Task { await submit() }
            } label: {
              Group {
                if showsProgress {
                  ProgressView()
                    .controlSize(.small)
                    .tint(showsStop ? OkouColor.interruptForeground : OkouColor.primaryForeground)
                } else {
                  if showsStop {
                    OkouIcon("square", size: OkouIconSize.inline)
                  } else {
                    OkouToolbarIcon("arrow-up")
                  }
                }
              }
              .font(.okou(size: 16, weight: .semibold))
              .foregroundStyle(
                showsStop
                  ? OkouColor.interruptForeground
                  : hasContent ? OkouColor.primaryForeground : OkouColor.mutedForeground)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .tint(
              showsStop ? OkouColor.interrupt : hasContent ? OkouColor.primary : OkouColor.muted
            )
            .disabled(
              (!hasContent && !showsStop) || !attachments.isReady || isBusy || needsUpgrade
                || voiceActive
                || draftState?.canSend == false
                || (!showsStop && modelSelection?.canSend == false)
            )
            .accessibilityLabel(showsStop ? "Stop" : "Send message")
            .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
            .frame(width: actionSize, height: actionSize)
            .contentShape(Circle())
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: hasContent)
          }
        }
      }
      .anchorPreference(key: ComposerSuggestionPresentation.self, value: .bounds) { bounds in
        guard let editor = draftState?.editor else { return nil }
        let content: ComposerSuggestionPresentation.Content
        if editor.workflows.query != nil {
          content = .workflows(editor.workflows)
        } else if editor.mentionQuery != nil {
          content = .chats(editor)
        } else {
          return nil
        }
        return ComposerSuggestionPresentation.Presentation(
          bounds: bounds, content: content, isDisabled: isBusy || needsUpgrade)
      }
      .animation(
        reduceMotion ? nil : sendTransition?.composerAnimation ?? .easeInOut(duration: 0.22),
        value: isFocused
      )
      .animation(
        !reduceMotion && sendTransition?.hidesBubbleID != nil
          ? sendTransition?.composerAnimation : nil,
        value: hasText)
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: voiceActive)
    .padding(.horizontal, OkouControl.pageInset)
    .padding(.top, OkouSpace.sm)
    .padding(.bottom, isFocused ? OkouSpace.sm : OkouSpace.six)
    .fixedSize(horizontal: false, vertical: true)
    .sensoryFeedback(.impact(weight: .light), trigger: sendFeedback)
    .sensoryFeedback(.impact(weight: .medium), trigger: stopFeedback)
    .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
    .onChange(of: "\(agentID ?? "")/\(connectorSelection != nil)", initial: true) { _, _ in
      showsConnectors = false
      connectorSelection?.configure(agentID: agentID)
    }
    .sheet(isPresented: $showsAddSheet, onDismiss: openPendingAdd) {
      ComposerAddSheet(
        attachments: attachments, connectorSelection: connectorSelection,
        clearDraft: clearDraftAction
      ) { action in
        pendingAdd = action
        showsAddSheet = false
      }
    }
    .sheet(isPresented: $showsModels) {
      if let modelSelection { ChatModelPickerView(selection: modelSelection) }
    }
    .sheet(isPresented: $showsConnectors) {
      if let connectorSelection {
        ComposerConnectorSheet(store: connectorSelection)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
          .okouSheetBackground()
      }
    }
    // Model settings decide whether the draft can be sent, so a mounted composer loads them
    // while the reader types; the open composer's model control shows what they resolve to.
    .task(id: modelSelection.map { ObjectIdentifier($0) }) {
      await modelSelection?.open()
    }
    .onChange(of: mentionSource, initial: true) { _, source in
      draftState?.editor.mentionSource = source
    }
    .onChange(of: "\(workflowSource?.id.uuidString ?? "")/\(agentID ?? "")", initial: true) {
      _, _ in
      draftState?.editor.workflows.configure(source: workflowSource, agentID: agentID)
    }
    .onChange(of: draftState.map(ObjectIdentifier.init), initial: true) { _, _ in
      mountedVoice?.suspend()
      mountedVoice = draftState?.voice
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { mountedVoice?.suspend() }
    }
    .onChange(of: newChatActivation) { _, _ in
      pendingAdd = nil
      showsAddSheet = false
      showsConnectors = false
      showsModels = false
      showsCamera = false
      showsScanner = false
      showsPhotos = false
      showsFiles = false
    }
    .onDisappear {
      draftState?.editor.workflows.dismiss()
      mountedVoice?.suspend()
    }
    .fullScreenCover(isPresented: $showsCamera) {
      ComposerCamera { url in attachments.importFiles([url]) }
        .ignoresSafeArea()
    }
    .fullScreenCover(isPresented: $showsScanner) {
      ComposerDocumentScanner { url in attachments.importFiles([url]) }
        .ignoresSafeArea()
    }
    .photosPicker(
      isPresented: $showsPhotos, selection: $selectedPhotos,
      matching: .any(of: [.images, .videos]), preferredItemEncoding: .current
    )
    .onChange(of: selectedPhotos) { _, photos in
      guard !photos.isEmpty else { return }
      attachments.importPhotos(photos)
      selectedPhotos = []
    }
    .fileImporter(
      isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
    ) {
      switch $0 {
      case .success(let urls): attachments.importFiles(urls)
      case .failure(let error): attachments.report(error)
      }
    }
  }

  /// "Clear draft" in Add to chat, only while there is something to clear.
  private var clearDraftAction: (() -> Void)? {
    guard let state = draftState, state.hasContent || state.error != nil else { return nil }
    return { state.clear() }
  }

  private func openPendingAdd() {
    guard let action = pendingAdd else { return }
    pendingAdd = nil
    switch action {
    case .camera: showsCamera = true
    case .photos: showsPhotos = true
    case .scan: showsScanner = true
    case .files: showsFiles = true
    case .connectors: showsConnectors = true
    }
  }
}
