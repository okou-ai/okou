import CCStateSwiftUI
import ChatData
import SwiftUI

struct NativeWorkspaceSetup: View {
  @State private var store: WorkspaceCreationStore
  let webURL: URL

  init(authentication: AuthenticationService, configuration: AppConfiguration) {
    _store = State(
      initialValue: WorkspaceCreationStore(
        authentication: authentication, configuration: configuration))
    webURL = configuration.webURL
  }

  var body: some View {
    StoreProvider(store.resources.store) {
      NativeWorkspaceSetupContent(store: store, webURL: webURL)
    }
    .onDisappear { store.close() }
  }
}

private struct NativeWorkspaceSetupContent: View {
  @Bindable var store: WorkspaceCreationStore
  let webURL: URL
  @LoadableValue private var status: Loadable<Bool>
  @FocusState private var isNameFocused: Bool

  init(store: WorkspaceCreationStore, webURL: URL) {
    self.store = store
    self.webURL = webURL
    _status = LoadableValue(task: store.resources.availability)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      switch status {
      case .loading: OkouLoadingRow("Getting things ready…")
      case .hasError(let error):
        OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
          store.retryStatus()
        }
        webSetup
      case .hasData(let enabled):
        if enabled {
          Text("Create your workspace to get started.")
            .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          TextField("Workspace name", text: $store.name)
            .textContentType(.organizationName)
            .textFieldStyle(OkouTextFieldStyle(isFocused: isNameFocused))
            .focused($isNameFocused)
            .submitLabel(.continue)
            .onSubmit { Task { await store.create() } }
            .disabled(store.isCreating)
            .accessibilityIdentifier("onboarding-workspace-name")
          Button {
            Task { await store.create() }
          } label: {
            ChatSettingsActionLabel(title: "Create workspace", isBusy: store.isCreating)
          }
          .buttonStyle(OkouButtonStyle(isPrimary: true))
          .disabled(
            store.isCreating || store.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          )
          .accessibilityIdentifier("onboarding-create-workspace")
          if let error = store.error {
            Text(error).font(.okou(.footnote)).foregroundStyle(OkouColor.destructive)
          }
        } else {
          webSetup
        }
      }
    }
  }

  private var webSetup: some View {
    VStack(alignment: .leading, spacing: OkouSpace.lg) {
      Text("Finish setting up your workspace on the web, then return here.")
        .foregroundStyle(OkouColor.mutedForeground)
      Link("Open Okou on the web", destination: webURL)
        .buttonStyle(OkouButtonStyle(isPrimary: false))
      Button("Refresh workspaces") { Task { await store.authentication.refresh() } }
        .buttonStyle(OkouButtonStyle(isPrimary: false))
    }
  }
}
