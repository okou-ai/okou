import ChatData
import SafariServices
import SwiftUI

struct ConnectorActionCard: View {
  let action: ChatConnectorAction
  let store: ConnectorActionStore
  let loadsState: Bool
  @ScaledMetric(relativeTo: .body) private var informationHeight: CGFloat = 80

  private var state: ConnectorActionStore.State {
    action.kind == .unavailable ? .unavailable : (store.states[action.id] ?? .loading)
  }

  var body: some View {
    Group {
      if action.kind == .unavailable {
        information
          .padding(.horizontal, 16).padding(.vertical, 12)
          .frame(maxWidth: .infinity, minHeight: 88, alignment: .leading)
          .modifier(ChatCardSurface())
      } else {
        ChatActionCard {
          information
            .frame(height: informationHeight, alignment: .leading)
        } actions: {
          switch state {
          case .loading:
            ProgressView("Loading connector…").font(.caption).frame(minHeight: 44)
          case .unavailable:
            EmptyView()
          case .failed:
            Button("Retry") { Task { await store.refresh(action) } }
          case .ready(let status):
            HStack {
              Button(button(status)) { store.activate(action) }
                .disabled(complete(status) || store.active != nil)
              if complete(status) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
              }
            }
          }
        }
      }
    }
    .accessibilityIdentifier("connector-action-card")
    .task(id: action.id) { if loadsState { await store.refresh(action) } }
  }

  @ViewBuilder private var information: some View {
    switch state {
    case .loading:
      ChatCardHeader(
        title: String(localized: "Loading connector…"), systemImage: "link", titleLineLimit: 1
      ) {
        EmptyView()
      }
    case .unavailable:
      ChatCardHeader(
        title: String(localized: "Action unavailable"), systemImage: "link.badge.plus", titleLineLimit: 1
      ) {
        Text("This action no longer matches an available connector in this conversation.")
          .lineLimit(2, reservesSpace: true)
      }
    case .failed(let error):
      ChatCardHeader(
        title: String(localized: "Could not load connector"), systemImage: "exclamationmark.circle",
        titleLineLimit: 1
      ) {
        Text(error).font(.caption).lineLimit(2, reservesSpace: true).textSelection(.enabled)
      }
    case .ready(let status):
      ChatCardHeader(title: status.label, systemImage: "link", titleLineLimit: 1) {
        Text(status.account?.label ?? String(localized: "Connect an account for this Agent"))
          .lineLimit(1, reservesSpace: true).textSelection(.enabled)
        (store.notices[action.id].map { Text($0) } ?? Text(reason(status)))
          .font(.caption).lineLimit(2, reservesSpace: true)
      }
    }
  }
  private func complete(_ status: ChatConnectorStatus) -> Bool {
    switch action.kind {
    case .reconnect: false
    case .select: status.selected
    default: status.complete
    }
  }
  private func button(_ status: ChatConnectorStatus) -> LocalizedStringKey {
    if complete(status) { return "Connected" }
    switch action.kind {
    case .select: return "Use this account"
    case .reconnect: return "Reconnect"
    default:
      if status.connected { return "Authorize Agent" }
      return status.account == nil ? "Connect" : "Reconnect"
    }
  }
  private func reason(_ status: ChatConnectorStatus) -> LocalizedStringKey {
    switch action.kind {
    case .select: return "Confirm this account for the conversation and continue."
    case .reconnect: return "Reconnect this exact account to continue."
    default:
      if status.complete { return "Connected and authorized for this Agent." }
      if status.connected { return "Allow this Agent to use the connected account." }
      if let reconnectReason = status.account?.reconnectReason {
        if reconnectReason == "configuration_incomplete"
          || reconnectReason == "configuration_invalid"
        {
          return "This account's connection details need attention. Reconnect to review them."
        }
        return "Your service authorization expired or was revoked. Sign in again."
      }
      if let description = status.builtin?.description { return LocalizedStringKey(description) }
      return "Connect this service to continue the conversation."
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
          Text(flow.status.label).font(.headline)
          if let account = flow.status.account {
            LabeledContent("Account", value: account.label).textSelection(.enabled)
            if let identity = account.externalEmail ?? account.externalUsername
              ?? account.externalId, identity != account.label
            {
              LabeledContent("Service account", value: identity).textSelection(.enabled)
            }
          }
          Text("Authorization applies to the Agent in this conversation.")
            .font(.footnote).foregroundStyle(.secondary)
        }
        if flow.needsConnection {
          if flow.status.builtin != nil {
            Section("Connection method") {
              Picker("Method", selection: $flow.methodID) {
                ForEach(
                  flow.status.builtin?.authMethods.filter { method in
                    method.grantKind != "managed"
                      && (flow.status.account == nil
                        || method.id == flow.status.account?.authMethod)
                  } ?? []
                ) { method in
                  Text(method.label).tag(method.id)
                }
              }.disabled(flow.busy || flow.waiting)
              if let description = flow.method?.description { Text(description).font(.footnote) }
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
                }.disabled(flow.busy || flow.waiting)
              }
              if flow.status.builtin?.connectNotice == "google-security-warning" {
                Text(
                  "Google may show a security warning for this connection. Review the requested access before continuing."
                )
                .font(.footnote)
              }
            }
          } else if flow.status.custom?.usesBrowserAuthorization != true {
            Section("Connection details") {
              ForEach(flow.status.custom?.fields ?? []) { field in
                credential(field.label, key: field.key, secret: field.kind == "secret")
                  .disabled(flow.busy || flow.waiting)
                if let description = field.description { Text(description).font(.footnote) }
              }
            }
          }
        }
        if flow.waiting {
          Section("Finish authorization") {
            if let code = flow.session?.userCode {
              LabeledContent("Verification code", value: code).textSelection(.enabled)
            }
            if flow.isExternalCode {
              SecureField("Authorization code", text: $flow.code)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            } else {
              Label("Waiting for authorization…", systemImage: "clock")
            }
            if let url = flow.session?.authorizationUrl ?? flow.session?.verificationUriComplete
              ?? flow.session?.verificationUri
            {
              Button("Open authorization page") { flow.browserURL = url }
            }
          }
        }
        if let error = flow.error {
          Section { Text(error).foregroundStyle(.red).textSelection(.enabled) }
        }
        if let notice = flow.notice { Section { Text(notice).foregroundStyle(.secondary) } }
        Section {
          Button {
            store.submit()
          } label: {
            HStack {
              Text(
                flow.operatedID != nil
                  ? "Retry continuation"
                  : (flow.isExternalCode ? "Submit code" : "Confirm and continue"))
              if flow.busy {
                Spacer()
                ProgressView()
              }
            }
          }
          .disabled(!flow.canSubmit)
          .accessibilityIdentifier("connector-confirm")
        }
      }
      .navigationTitle("Connect service")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { store.cancel() } }
      }
      .onChange(of: flow.methodID) { _, _ in
        flow.values = [:]
        flow.options = [:]
        for option in flow.method?.startOptions ?? [] {
          flow.options[option.id] = option.defaultValue
        }
      }
      .sheet(
        isPresented: Binding(
          get: { flow.browserURL != nil }, set: { if !$0 { store.browserDismissed() } })
      ) {
        if let url = flow.browserURL { ConnectorSafariView(url: url) { store.browserDismissed() } }
      }
    }
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
