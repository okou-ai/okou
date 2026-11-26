import CCState
import CCStateSwiftUI
import ChatData
import SafariServices
import SwiftUI

struct ConnectorActionCard: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  let loadsState: Bool
  private let read: ConnectorActionRead

  init(action: ChatConnectorAction, store: ConnectorActionStore, loadsState: Bool) {
    self.action = action
    self.store = store
    self.loadsState = loadsState
    read = store.resources.read(action)
  }

  var body: some View {
    StoreProvider(read.store) {
      ConnectorActionDemandCard(action: action, store: store, read: read, loadsState: loadsState)
    }.id(ObjectIdentifier(read))
  }
}

private struct ConnectorActionDemandCard: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  let read: ConnectorActionRead
  let loadsState: Bool
  @LoadableValue private var requested: Loadable<Bool>

  init(
    action: ChatConnectorAction, store: ConnectorActionStore, read: ConnectorActionRead,
    loadsState: Bool
  ) {
    self.action = action
    self.store = store
    self.read = read
    self.loadsState = loadsState
    _requested = LoadableValue(read.requested)
  }

  var body: some View {
    Group {
      if action.kind == .unavailable {
        ConnectorActionCardContent(action: action, store: store, state: .unavailable)
      } else if requested.data == true {
        ConnectorActionResourceCard(action: action, store: store, read: read)
      } else {
        ConnectorActionCardContent(action: action, store: store, state: .loading)
      }
    }
    .task(id: loadsState) { if loadsState { _ = await read.result() } }
  }
}

private struct ConnectorActionResourceCard: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  @LoadableValue private var status: Loadable<ChatConnectorStatus?>

  init(action: ChatConnectorAction, store: ConnectorActionStore, read: ConnectorActionRead) {
    self.action = action
    self.store = store
    _status = LoadableValue(task: read.value)
  }

  var body: some View {
    ConnectorActionCardContent(action: action, store: store, state: state)
  }

  private var state: ConnectorActionCardContent.State {
    switch status {
    case .loading: return .loading
    case .hasError: return .failed
    case .hasData(let value):
      return value.map(ConnectorActionCardContent.State.ready) ?? .unavailable
    }
  }
}

private struct ConnectorActionCardContent: View {
  enum State {
    case loading, unavailable, failed
    case ready(ChatConnectorStatus)
  }

  let action: ChatConnectorAction
  let store: ConnectorActionStore
  let state: State
  @ScaledMetric(relativeTo: .body) private var informationHeight: CGFloat = 80
  /// The authorization attempt and confirmed notices, kept in the workspace session's Store.
  @ResolvedValue private var resolvedPresentation: ConnectorActionStore.Presentation?

  init(action: ChatConnectorAction, store: ConnectorActionStore, state: State) {
    self.action = action
    self.store = store
    self.state = state
    _resolvedPresentation = ResolvedValue(store.presentationValue)
  }

  private var presentation: ConnectorActionStore.Presentation {
    resolvedPresentation ?? store.presentation
  }

  var body: some View {
    Group {
      if action.kind == .unavailable {
        information
          .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
          .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
          .modifier(ChatCardSurface())
      } else {
        ChatActionCard {
          information
            .frame(height: informationHeight, alignment: .leading)
        } actions: {
          switch state {
          case .loading:
            // The heading already says "Loading connector…"; the action slot keeps its height.
            Color.clear.frame(height: OkouControl.minimumTarget).accessibilityHidden(true)
          case .unavailable:
            Color.clear.frame(height: 44).accessibilityHidden(true).allowsHitTesting(false)
          case .failed:
            Button("Review connection") { store.activate(action) }
          case .ready(let status):
            HStack {
              Button(button(status)) { store.activate(action) }
                .disabled(complete(status) || presentation.active != nil)
              if complete(status) {
                OkouIcon("circle-check").foregroundStyle(OkouStatusColor.success)
              }
            }
          }
        }
      }
    }
    .accessibilityIdentifier("connector-action-card")
  }

  @ViewBuilder private var information: some View {
    switch state {
    case .loading:
      ChatCardHeader(
        title: String(localized: "Loading connector…"), icon: "link", titleLineLimit: 1
      ) {
        EmptyView()
      }
    case .unavailable:
      ChatCardHeader(
        title: String(localized: "Action unavailable"), icon: "link",
        titleLineLimit: 1
      ) {
        Text("This action no longer matches an available connector in this chat.")
          .lineLimit(2, reservesSpace: true)
      }
    case .failed:
      ChatCardHeader(
        title: String(localized: "Connection details unavailable"), icon: "link",
        titleLineLimit: 1
      ) {
        Text("Open this connection to try again.").lineLimit(2, reservesSpace: true)
      }
    case .ready(let status):
      ChatCardHeader(title: status.label, icon: "link", titleLineLimit: 1) {
        Text(status.account?.label ?? String(localized: "Connect an account"))
          .lineLimit(1, reservesSpace: true).textSelection(.enabled)
        (presentation.notices[action.id].map { Text($0) } ?? Text(reason(status)))
          .lineLimit(2, reservesSpace: true)
      }
    }
  }
  private func complete(_ status: ChatConnectorStatus) -> Bool {
    switch action.kind {
    case .reconnect: false
    case .select: status.selected
    default: status.connected
    }
  }
  private func button(_ status: ChatConnectorStatus) -> LocalizedStringKey {
    if complete(status) { return "Connected" }
    switch action.kind {
    case .select: return action.isMemberApproval ? "Allow for 1h" : "Use this account"
    case .reconnect: return "Reconnect"
    default:
      return status.account == nil ? "Connect" : "Reconnect"
    }
  }
  private func reason(_ status: ChatConnectorStatus) -> LocalizedStringKey {
    switch action.kind {
    case .select:
      return action.isMemberApproval
        ? "Allow across your chats. Select this account here."
        : "Confirm this account for the chat and continue."
    case .reconnect: return "Reconnect this exact account to continue."
    default:
      if status.connected { return "Account connected." }
      if let reconnectReason = status.account?.reconnectReason {
        if reconnectReason == "configuration_incomplete"
          || reconnectReason == "configuration_invalid"
        {
          return "This account's connection details need attention. Reconnect to review them."
        }
        return "Your service authorization expired or was revoked. Sign in again."
      }
      if let description = status.builtin?.description { return LocalizedStringKey(description) }
      return "Connect this service to continue the chat."
    }
  }

}

struct ConnectorAuthorizationSheet: View {
  @Bindable var flow: ConnectorAuthorizationFlow
  let store: ConnectorActionStore

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text(flow.status.label).font(.okou(.headline))
          if let account = flow.status.account {
            LabeledContent("Account", value: account.label).textSelection(.enabled)
            if let identity = account.externalEmail ?? account.externalUsername
              ?? account.externalId, identity != account.label
            {
              LabeledContent("Service account", value: identity).textSelection(.enabled)
            }
          }
        } footer: {
          if let account = flow.status.account, flow.methodID != account.authMethod {
            Text("Connecting with this method replaces this account’s current authorization.")
              .okouSectionNote()
          } else if flow.action.isMemberApproval {
            Text("Allow across your chats. Select this account here.")
              .okouSectionNote()
          } else {
            Text("Connect this account to make it available in your account settings.")
              .okouSectionNote()
          }
        }
        if flow.needsConnection {
          if flow.status.builtin != nil, showsMethodDetails {
            Section {
              if flow.availableMethods.count > 1 {
                Picker("Method", selection: $flow.methodID) {
                  ForEach(flow.availableMethods) { method in
                    Text(method.label).tag(method.id)
                  }
                }
                .okouValuePicker().disabled(flow.busy || flow.waiting)
              }
              if let description = flow.method?.description {
                Text(description).font(.okou(.footnote))
              }
              ForEach(flow.method?.manualFields ?? []) { field in
                credential(field.label, key: field.id, secret: field.inputType == "password")
                  .disabled(flow.busy || flow.waiting)
              }
              ForEach(flow.method?.startOptions ?? []) { option in
                Picker(
                  option.label,
                  selection: Binding(
                    get: { flow.options[option.id] ?? option.defaultValue ?? "" },
                    set: { flow.options[option.id] = $0 })
                ) {
                  ForEach(option.options, id: \.value) { Text($0.label).tag($0.value) }
                }
                .okouValuePicker()
                .disabled(flow.busy || flow.waiting)
              }
              if flow.status.builtin?.connectNotice == "google-security-warning" {
                Text(
                  "Google may show a security warning for this connection. Review the requested access before continuing."
                )
                .font(.okou(.footnote))
              }
            } header: {
              Text(methodSectionTitle).okouSectionHeader()
            }
          } else if let custom = flow.status.custom, !custom.usesBrowserAuthorization {
            Section {
              ForEach(custom.fields) { field in
                credential(field.label, key: field.key, secret: field.kind == "secret")
                  .disabled(flow.busy || flow.waiting)
                if let description = field.description { Text(description).font(.okou(.footnote)) }
              }
            } header: {
              Text("Connection details").okouSectionHeader()
            }
          }
        }
        if flow.waiting {
          Section {
            if let code = flow.session?.userCode {
              LabeledContent("Verification code", value: code).textSelection(.enabled)
            }
            if flow.isExternalCode {
              SecureField("Authorization code", text: $flow.code)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            } else {
              Label("Waiting for authorization…", okouSymbol: "clock")
            }
            if let url = flow.session?.authorizationUrl ?? flow.session?.verificationUriComplete
              ?? flow.session?.verificationUri
            {
              Button("Open authorization page") { flow.browserURL = url }
                .disabled(flow.busy)
            }
          } header: {
            Text("Finish authorization").okouSectionHeader()
          }
        }
        if let error = flow.error {
          Section { Text(error).foregroundStyle(OkouColor.destructive).textSelection(.enabled) }
        }
        if let notice = flow.notice {
          Section { Text(notice).foregroundStyle(OkouColor.mutedForeground) }
        }
        Section {
          Button {
            store.submit()
          } label: {
            ChatSettingsActionLabel(title: confirmationTitle, isBusy: flow.busy)
          }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
          .disabled(!flow.canSubmit)
          .accessibilityIdentifier("connector-confirm")
        }
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      .okouGroupedBackground()
      .listSectionSpacing(OkouSpace.lg)
      .navigationTitle(flow.action.isMemberApproval ? Text("Account") : Text("Connect service"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem { store.cancel() }
      }
      .onChange(of: flow.methodID) { _, _ in
        flow.values = [:]
        flow.options = [:]
      }
    }
  }
  private var showsMethodDetails: Bool {
    flow.availableMethods.count > 1 || flow.method?.description != nil
      || flow.method?.manualFields.isEmpty == false || flow.method?.startOptions.isEmpty == false
      || flow.status.builtin?.connectNotice != nil
  }
  private var methodSectionTitle: LocalizedStringKey {
    flow.availableMethods.count > 1 ? "Connection method" : "Connection details"
  }
  private var confirmationTitle: LocalizedStringKey {
    if flow.busy {
      if flow.operatedID != nil { return "Continuing chat…" }
      return flow.isExternalCode ? "Submitting code…" : "Connecting…"
    }
    if flow.operatedID != nil { return "Retry continuation" }
    if flow.action.isMemberApproval { return "Allow for 1h" }
    if flow.isExternalCode { return "Submit code" }
    if flow.needsConnection { return flow.status.account == nil ? "Connect" : "Reconnect" }
    return "Confirm and continue"
  }

  @ViewBuilder private func credential(_ label: String, key: String, secret: Bool) -> some View {
    let value = Binding(get: { flow.values[key] ?? "" }, set: { flow.values[key] = $0 })
    if secret {
      SecureField(label, text: value).textInputAutocapitalization(.never).autocorrectionDisabled()
    } else {
      TextField(label, text: value).textInputAutocapitalization(.never).autocorrectionDisabled()
    }
  }
}

struct ConnectorSafariView: UIViewControllerRepresentable {
  let url: URL
  let onDone: () -> Void
  func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }
  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.delegate = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
  final class Coordinator: NSObject, SFSafariViewControllerDelegate {
    let onDone: () -> Void
    init(onDone: @escaping () -> Void) { self.onDone = onDone }
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) { onDone() }
  }
}
