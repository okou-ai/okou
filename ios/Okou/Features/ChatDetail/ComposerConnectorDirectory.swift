import ChatData
import SwiftUI

struct ComposerConnectorDirectory: View {
  let store: ComposerConnectorStore
  @State private var tab = "discover"
  @State private var search = ""
  @State private var category = ""
  @State private var catalog: [ChatCatalogConnector] = []
  @State private var custom: [ChatCustomConnector] = []
  @State private var categories: [String] = []
  @State private var error: String?
  @State private var loading = false
  @State private var requestID = UUID()

  var body: some View {
    List {
      Picker("Directory", selection: $tab) {
        Text("Discover").tag("discover")
        Text("Custom").tag("custom")
      }.pickerStyle(.segmented)
      if tab == "discover", !categories.isEmpty {
        Picker("Category", selection: $category) {
          Text("All categories").tag("")
          ForEach(categories, id: \.self) {
            Text($0.replacingOccurrences(of: "-", with: " ").capitalized).tag($0)
          }
        }
      }
      if let error { ConnectorLoadError(error: error) { await load() } }
      if loading { ProgressView("Loading connectors…") }
      if tab == "discover" {
        ForEach(catalog) { connector in
          NavigationLink {
            ComposerConnectorDetail(store: store, connector: connector)
          } label: {
            VStack(alignment: .leading, spacing: 5) {
              Text(connector.label)
              Text(connector.description).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
          }
        }
      } else {
        ForEach(
          custom.filter {
            search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search)
          }, id: \.id
        ) { connector in
          Button {
            if connector.managed || connector.permissionBundleRef != nil {
              openConnector(connector.slug)
            } else {
              store.connect(target: .custom(connector.id))
            }
          } label: {
            Label(connector.displayName, systemImage: "puzzlepiece.extension").foregroundStyle(
              .primary)
          }
        }
        Button("Create custom connector") {
          store.openWeb(path: "connectors", query: [URLQueryItem(name: "scope", value: "custom")])
        }
      }
      if !loading, error == nil,
        tab == "discover" ? catalog.isEmpty : custom.isEmpty
      {
        ContentUnavailableView.search(text: search)
      }
      Section("Remote access") {
        Button("Set up SSH") { store.setupRemote(.ssh) }
        Button("Set up VNC") { store.setupRemote(.vnc) }
      }
    }
    .navigationTitle("Add connectors")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "Find connectors")
    .task(id: "\(tab)/\(search)/\(category)") { await load() }
    .refreshable { await load() }
    .onChange(of: store.webDestination?.id) { _, destinationID in
      if destinationID == nil { Task { await load() } }
    }
  }
  private func openConnector(_ slug: String) {
    guard let agentID = store.agentID else { return }
    store.openWeb(
      path: "connectors/\(slug)/connect", query: [URLQueryItem(name: "agentId", value: agentID)])
  }
  private func load() async {
    let request = UUID()
    requestID = request
    loading = true
    defer { if requestID == request { loading = false } }
    do {
      if tab == "discover" {
        let result = try await store.service.discover(
          keyword: search, category: category.isEmpty ? nil : category)
        guard !Task.isCancelled, requestID == request else { return }
        catalog = result.connectors
        if let counts = result.categoryConnectorCounts { categories = counts.keys.sorted() }
      } else {
        let result = try await store.service.customConnectors()
        guard !Task.isCancelled, requestID == request else { return }
        custom = result
      }
      error = nil
    } catch is CancellationError {
    } catch {
      guard requestID == request else { return }
      self.error = error.localizedDescription
    }
  }
}

private struct ComposerConnectorDetail: View {
  let store: ComposerConnectorStore
  let connector: ChatCatalogConnector
  var body: some View {
    Form {
      Section { Text(connector.description) }
      Section("Connection methods") {
        ForEach(connector.authMethods) { method in
          VStack(alignment: .leading, spacing: 5) {
            Text(method.label)
            if let description = method.description {
              Text(description).font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      Section {
        Button("Connect account") {
          if connector.authMethods.contains(where: { $0.grantKind != "managed" }) {
            store.connect(target: .builtin(connector.slug))
          } else if let agentID = store.agentID {
            store.openWeb(
              path: "connectors/\(connector.slug)/connect",
              query: [URLQueryItem(name: "agentId", value: agentID)])
          }
        }
        if connector.permissionSummary.hasPermissions {
          NavigationLink("Configure permissions") {
            ComposerConnectorPermissions(store: store, slug: connector.slug, label: connector.label)
          }
        }
      }
    }
    .navigationTitle(connector.label)
    .navigationBarTitleDisplayMode(.inline)
  }
}
