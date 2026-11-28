import CCStateSwiftUI
import ChatData
import SwiftUI

struct SettingsRemoteDevicesSection: View {
  let resources: RemoteDeviceResources
  let webURL: URL
  @ResolvedValue private var enabled: Bool?

  init(resources: RemoteDeviceResources, webURL: URL) {
    self.resources = resources
    self.webURL = webURL
    _enabled = ResolvedValue(resources.enabled)
  }

  var body: some View {
    if enabled == true {
      Section {
        NavigationLink {
          RemoteDevicesView(resources: resources, webURL: webURL)
        } label: {
          OkouRowLabel("Remote devices", okouSymbol: "monitor")
        }
      }
    }
  }
}

struct RemoteDevicesView: View {
  let resources: RemoteDeviceResources
  let webURL: URL
  @State private var showsCreate = false
  @Environment(\.scenePhase) private var scenePhase

  init(resources: RemoteDeviceResources, webURL: URL) {
    self.resources = resources
    self.webURL = webURL
  }

  var body: some View {
    List {
      RemoteDeviceRows(resources: resources, webURL: webURL)
      Section {
        Button("Create device", okouSymbol: "plus") { showsCreate = true }
        Link("Set up a channel on Web", destination: setupURL())
      }
    }
    .okouGroupedBackground()
    .navigationTitle("Remote devices").navigationBarTitleDisplayMode(.inline)
    .refreshable { await resources.reload() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { resources.refresh() }
    }
    .sheet(isPresented: $showsCreate) { CreateRemoteDeviceView(resources: resources) }
  }

  private func setupURL() -> URL {
    webURL.appending(path: "connectors").appending(queryItems: [
      URLQueryItem(name: "scope", value: "remote-control"),
      URLQueryItem(name: "setup", value: "add")
    ])
  }
}

struct RemoteDeviceRows: View {
  let resources: RemoteDeviceResources
  let webURL: URL
  @LoadableValue private var directory: Loadable<[ChatRemoteDevice]>
  @ResolvedValue private var write: RemoteDeviceResources.WriteState?

  init(resources: RemoteDeviceResources, webURL: URL) {
    self.resources = resources
    self.webURL = webURL
    _directory = LoadableValue(task: resources.directory, keepLast: true)
    _write = ResolvedValue(resources.writeState)
  }

  var body: some View {
    Section {
      switch directory {
      case .loading: ComposerConnectorSkeletonRows("Loading remote devices…")
      case .hasError:
        Button("Retry loading remote devices") { resources.refresh() }
      case .hasData(let devices):
        ForEach(devices) { device in
          HStack {
            NavigationLink {
              RemoteDeviceDetailView(deviceID: device.id, resources: resources, webURL: webURL)
            } label: {
              OkouRowLabel(Text(verbatim: device.displayName)) {
                OkouIcon("monitor", size: OkouIconSize.standard)
              }
            }
            RemoteDevicePolicyMenu(device: device, resources: resources)
          }
        }
        if devices.isEmpty {
          Text("No remote devices yet.").foregroundStyle(OkouColor.mutedForeground)
        }
      }
      if let error = write?.error { Text(error).foregroundStyle(OkouColor.destructive) }
    } header: {
      Text("Remote devices").okouSectionHeader()
    }
  }
}

private struct RemoteDevicePolicyMenu: View {
  let device: ChatRemoteDevice
  let resources: RemoteDeviceResources
  @ResolvedValue private var write: RemoteDeviceResources.WriteState?

  init(device: ChatRemoteDevice, resources: RemoteDeviceResources) {
    self.device = device
    self.resources = resources
    _write = ResolvedValue(resources.writeState)
  }

  var body: some View {
    TimelineView(.explicit(device.accessExpiresAt.map { [$0] } ?? [])) { timeline in
      Menu {
        ForEach(ChatRemoteDevices.Policy.allCases, id: \.self) { policy in
          Button(policyTitle(policy)) { Task { await resources.apply(.policy(policy, device.id)) } }
        }
      } label: {
        status(at: timeline.date).font(.okou(.subheadline))
      }
      .buttonStyle(.borderless)
      .disabled(write?.saving == true)
      .accessibilityLabel("Access for \(device.displayName)")
      .accessibilityValue(status(at: timeline.date))
    }
  }

  private func status(at date: Date) -> Text {
    guard device.accessAllowed else { return Text("Off") }
    guard let expiry = device.accessExpiresAt else { return Text("Always") }
    return expiry > date ? Text(expiry, style: .relative) : Text("Off")
  }

  private func policyTitle(_ policy: ChatRemoteDevices.Policy) -> LocalizedStringKey {
    switch policy {
    case .always: "Allow always"
    case .oneHour: "Allow for 1 hour"
    case .twentyFourHours: "Allow for 24 hours"
    case .sevenDays: "Allow for 7 days"
    case .denied: "Deny"
    }
  }
}

private struct RemoteDeviceDetailView: View {
  let deviceID: UUID
  let resources: RemoteDeviceResources
  let webURL: URL
  @LoadableValue private var directory: Loadable<[ChatRemoteDevice]>
  @ResolvedValue private var write: RemoteDeviceResources.WriteState?

  init(deviceID: UUID, resources: RemoteDeviceResources, webURL: URL) {
    self.deviceID = deviceID
    self.resources = resources
    self.webURL = webURL
    _directory = LoadableValue(task: resources.directory, keepLast: true)
    _write = ResolvedValue(resources.writeState)
  }

  var body: some View {
    switch directory {
    case .loading: OkouLoadingRow("Loading remote devices…")
    case .hasError: Button("Retry loading remote devices") { resources.refresh() }
    case .hasData(let devices):
      if let device = devices.first(where: { $0.id == deviceID }) {
        content(device, destinations: devices.filter { $0.id != device.id })
      } else {
        Text("This device is unavailable.").foregroundStyle(OkouColor.mutedForeground)
      }
    }
  }

  private func content(_ device: ChatRemoteDevice, destinations: [ChatRemoteDevice]) -> some View {
    Form {
      Section {
        HStack {
          Text("Permission")
          Spacer()
          RemoteDevicePolicyMenu(device: device, resources: resources)
        }
      }
      Section {
        ForEach(device.channels, id: \.directoryKey) { channel in
          HStack {
            VStack(alignment: .leading, spacing: OkouSpace.xs) {
              Text(verbatim: channel.displayName)
              Text(verbatim: protocolName(channel.kind))
                .font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            }
            Spacer()
            if !destinations.isEmpty {
              Menu("Move") {
                ForEach(destinations) { destination in
                  Button(destination.displayName) {
                    Task { await resources.apply(.move(channel, destination.id)) }
                  }
                }
              }
              .disabled(write?.saving == true)
              .accessibilityLabel("Move \(channel.displayName) to another device")
            }
          }
        }
        if device.channels.isEmpty {
          Text("No channels").foregroundStyle(OkouColor.mutedForeground)
        }
        Link(
          "Add channel on Web",
          destination: webURL.appending(path: "connectors").appending(queryItems: [
            URLQueryItem(name: "scope", value: "remote-control"),
            URLQueryItem(name: "remoteDevice", value: device.id.uuidString.lowercased()),
            URLQueryItem(name: "setup", value: "add")
          ]))
      } header: {
        Text("Channels").okouSectionHeader()
      }
      if let error = write?.error { Text(error).foregroundStyle(OkouColor.destructive) }
    }
    .okouGroupedBackground()
    .navigationTitle(device.displayName).navigationBarTitleDisplayMode(.inline)
  }

  private func protocolName(_ kind: ChatRemoteDevice.Channel.Kind) -> String {
    switch kind {
    case .desktop: "Okou Desktop"
    case .ios: "iOS"
    case .ssh: "SSH"
    case .vnc: "VNC"
    }
  }
}

extension ChatRemoteDevice.Channel {
  fileprivate var directoryKey: String { "\(kind.rawValue):\(id)" }
}

private struct CreateRemoteDeviceView: View {
  let resources: RemoteDeviceResources
  @ResolvedValue private var write: RemoteDeviceResources.WriteState?
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var deviceID = UUID()

  init(resources: RemoteDeviceResources) {
    self.resources = resources
    _write = ResolvedValue(resources.writeState)
  }

  var body: some View {
    NavigationStack {
      Form {
        TextField("Device name", text: $name)
        if let error = write?.error { Text(error).foregroundStyle(OkouColor.destructive) }
      }
      .okouGroupedBackground()
      .navigationTitle("Add device").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        OkouCloseToolbarItem { dismiss() }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            Task {
              if await resources.apply(.create(deviceID, name)) { dismiss() }
            }
          }
          .disabled(
            name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || name.utf16.count > 120
              || write?.saving == true)
        }
      }
    }
    .okouSheetBackground()
  }
}
