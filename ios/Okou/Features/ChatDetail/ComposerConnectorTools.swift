import CCState
import CCStateSwiftUI
import ChatData
import SwiftUI

struct ComposerConnectorTools: View {
  let store: ComposerConnectorStore
  let resources: ComposerConnectorResources
  @LoadableValue private var remote: Loadable<ComposerConnectorResources.Remote>
  @ResolvedValue private var remoteDevicesEnabled: Bool?
  @State private var showsDesktopSetup = false
  /// The composer's confirmed connectors and remote access, kept in the session Store.
  @ResolvedValue private var resolvedSnapshot: ComposerConnectorStore.Snapshot?
  private static let disabled = Computed<Bool> { _ in false }
  /// The composer's writes and a new chat's pending choices, kept in the same Store.
  @ResolvedValue private var resolvedConnectorStatus: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore, resources: ComposerConnectorResources) {
    self.store = store
    self.resources = resources
    _remote = LoadableValue(task: resources.remote, keepLast: true)
    _remoteDevicesEnabled = ResolvedValue(store.remoteDevices?.enabled ?? Self.disabled)
    _resolvedSnapshot = ResolvedValue(store.snapshotValue)
    _resolvedConnectorStatus = ResolvedValue(store.statusValue)
  }

  private var snapshot: ComposerConnectorStore.Snapshot { resolvedSnapshot ?? store.snapshot }
  private var connectorStatus: ComposerConnectorStore.Status {
    resolvedConnectorStatus ?? store.status
  }

  var body: some View {
    Section {
      switch remote {
      case .loading where snapshot.remotes == nil:
        ComposerConnectorSkeletonRows("Loading remote access…")
      case .hasError(let error):
        ConnectorLoadError(
          error: ComposerConnectorResources.message(for: error, in: .remote)
        ) { await store.refresh() }
      case .loading, .hasData:
        Toggle(
          isOn: Binding(
            get: {
              store.computerAccess(in: snapshot, status: connectorStatus).cloudBrowserEnabled
            },
            set: { enabled in
              Task {
                await store.setComputerAccess(ChatComputerAccess(cloudBrowserEnabled: enabled))
              }
            })
        ) { OkouRowLabel("Cloud browser", okouSymbol: "globe") }
        .tint(OkouColor.primary400)
        .disabled(!connectorStatus.canSend || snapshot.remotes?.cloudBrowserAvailable != true)
      }
      if remoteDevicesEnabled != true {
        NavigationLink {
          ComposerRemoteControls(store: store, resources: resources)
        } label: {
          OkouRowLabel("Remote access", okouSymbol: "monitor")
        }
        Button("Connect my computer", okouSymbol: "plus") { showsDesktopSetup = true }
      }
    }
    .sheet(isPresented: $showsDesktopSetup) { ComposerDesktopSetup(store: store) }
    if remoteDevicesEnabled == true, let devices = store.remoteDevices {
      RemoteDeviceRows(resources: devices, webURL: store.webURL)
    }
  }
}

struct ComposerDesktopSetup: View {
  let store: ComposerConnectorStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Text("Install Okou Desktop on your Mac, connect your account, then reopen Connectors.")
        ShareLink("Share Desktop download link", item: store.service.desktopDownloadURL)
        Link("Download for Mac", destination: store.service.desktopDownloadURL)
      }
      .okouGroupedBackground().navigationTitle("Connect my computer")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
    }.presentationDetents([.medium]).okouSheetBackground()
  }
}
