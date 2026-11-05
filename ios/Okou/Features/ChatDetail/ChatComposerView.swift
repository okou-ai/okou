import ChatDomain
import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct ChatComposerView: View {
  static let compactHeight: CGFloat = 56

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
  var voice: VoiceInputStore? = nil
  /// "Message <agent>", so the field names who will do the work.
  var placeholder: String? = nil

  @State private var isFocused = false
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var showsConnectors = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @State private var showsCamera = false
  @State private var showsAddSheet = false
  /// What "Add to chat" asked for; the composer opens it once the sheet has gone.
  @State private var pendingAdd: ComposerAddAction?
  @State private var showsScanner = false
  @State private var trailingWidth: CGFloat = 106
  @State private var sendFeedback = 0
  @State private var stopFeedback = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let actionSize = OkouControl.minimumTarget

  private var cornerRadius: CGFloat { Self.compactHeight / 2 }
  private var actionInset: CGFloat { cornerRadius - actionSize / 2 }

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var hasContent: Bool {
    hasText || attachments.hasAttachments || draftState?.hasContent == true
  }
  /// A draft keeps the open layout after the keyboard closes; collapsing it cut the text to
  /// one truncated line under the controls.
  /// Dictating collapses the composer to the one-line voice bar, whatever it held.
  private var expandsInput: Bool {
    if isDictating { return false }
    return isFocused || hasText || draftState?.document.hasFeedback == true
      || draftState?.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
  }
  private var isDictating: Bool { voice?.isActive == true }
  private var showsStop: Bool { canStop && !hasContent }
  /// The mic stays beside send once there is a draft, so a typed message can go on by voice.
  private var showsMic: Bool {
    voice != nil && !showsStop && !showsProgress && !needsUpgrade
  }
  private var showsSend: Bool { voice == nil || hasContent || showsStop || showsProgress }
  private var canSendDictation: Bool {
    attachments.isReady && !isBusy && !needsUpgrade && draftState?.canSend != false
      && modelSelection?.canSend != false
  }
  private var resolvedPlaceholder: String { placeholder ?? String(localized: "Message Okou") }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
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
      if let voice, let voiceError = voice.error {
        OkouBanner(
          Text(voiceError), icon: "mic", tone: .problem, dismiss: { voice.error = nil })
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
      if let editor = draftState?.editor, !editor.mentionSuggestions.isEmpty {
        ComposerMentionMenu(editor: editor, suggestions: editor.mentionSuggestions)
      }
      // Retired native editors must leave immediately. Fading a first responder
      // through a draft reset can restart keyboard avoidance during the send flight.
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
      .opacity(isDictating ? 0 : 1)
      .allowsHitTesting(!isDictating)
      .padding(
        .leading, expandsInput ? 18 : 58
      )
      .padding(.trailing, expandsInput ? 18 : trailingWidth + actionInset + OkouSpace.sm)
      .padding(.top, expandsInput ? 17 : 10)
      .padding(.bottom, expandsInput ? 62 : 10)
      .frame(
        minHeight: expandsInput ? 116 : Self.compactHeight,
        alignment: expandsInput ? .topLeading : .leading
      )
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
      .anchorPreference(key: ComposerWorkflowPresentation.self, value: .bounds) { bounds in
        guard let workflows = draftState?.editor.workflows, workflows.query != nil else {
          return nil
        }
        return ComposerWorkflowPresentation.Presentation(
          bounds: bounds, suggestions: workflows, isDisabled: isBusy || needsUpgrade)
      }
      .overlay(alignment: expandsInput ? .bottomLeading : .leading) {
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
          // The model control lives in the header beside the menu (ChatWorkspaceHeader).
        }
        .padding(.leading, actionInset)
        .padding(.bottom, expandsInput ? actionInset : 0)
        .opacity(isDictating ? 0 : 1)
        .allowsHitTesting(!isDictating)
      }
      .overlay(alignment: expandsInput ? .bottomTrailing : .trailing) {
        HStack(spacing: OkouSpace.xs) {
          if showsMic, let voice {
            Button {
              // The keyboard goes away with the text field: the bar replaces both.
              UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
              Task { await voice.start() }
            } label: {
              OkouToolbarIcon("mic")
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .disabled(isBusy || voice.isActive)
            .accessibilityLabel("Dictate a message")
            .accessibilityIdentifier("dictate-message")
            .frame(width: actionSize, height: actionSize)
            .contentShape(Circle())
          }
          if showsSend {
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
                showsStop ? OkouColor.interruptForeground : OkouColor.primaryForeground)
            }
            .buttonStyle(.glassProminent)
            .buttonBorderShape(.circle)
            .tint(showsStop ? OkouColor.interrupt : OkouColor.primary)
            .disabled(
              (!hasContent && !showsStop) || !attachments.isReady || isBusy || needsUpgrade
                || draftState?.canSend == false
                || (!showsStop && modelSelection?.canSend == false)
            )
            .accessibilityLabel(showsStop ? "Stop" : "Send message")
            .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
            .frame(width: actionSize, height: actionSize)
            .contentShape(Circle())
          }
        }
        .onGeometryChange(for: CGFloat.self) {
          $0.size.width
        } action: {
          trailingWidth = $0
        }
        .padding(.leading, expandsInput ? actionSize + actionInset + OkouSpace.xs : 0)
        .padding(.trailing, actionInset)
        .padding(.bottom, expandsInput ? actionInset : 0)
        .opacity(isDictating ? 0 : 1)
        .allowsHitTesting(!isDictating)
      }
      .overlay {
        if let voice, voice.isActive {
          VoiceRecordingBar(voice: voice, canSend: canSendDictation) { send in
            finishDictation(voice, send: send)
          }
          .transition(.opacity)
        }
      }
      .animation(reduceMotion ? nil : .smooth(duration: 0.3), value: isDictating)
      .animation(
        reduceMotion ? nil : sendTransition?.composerAnimation ?? .easeInOut(duration: 0.22),
        value: isFocused
      )
      .animation(
        !reduceMotion && sendTransition?.hidesBubbleID != nil
          ? sendTransition?.composerAnimation : nil,
        value: hasText)
    }
    .padding(.horizontal, OkouSpace.lg)
    .padding(.top, OkouSpace.sm)
    .padding(.bottom, isFocused ? 8 : 0)
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
    .sheet(isPresented: $showsConnectors) {
      if let connectorSelection {
        ComposerConnectorSheet(store: connectorSelection)
          .presentationDetents([.medium, .large])
          .presentationDragIndicator(.visible)
      }
    }
    // Model settings decide whether the draft can be sent, so a mounted composer loads them
    // while the reader types; the header's model capsule shows what they resolve to.
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
    .onDisappear {
      draftState?.editor.workflows.dismiss()
      voice?.cancel()
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

  /// Stop puts the words into the draft to edit; send sends them as heard, like ChatGPT.
  private func finishDictation(_ voice: VoiceInputStore, send: Bool) {
    Task {
      guard let text = await voice.finish() else { return }
      if let editor = draftState?.editor {
        editor.appendText(text)
      } else if draft.isEmpty {
        draft = text
      } else {
        draft += " " + text
      }
      if send {
        sendFeedback += 1
        await submit()
      }
    }
  }
}
