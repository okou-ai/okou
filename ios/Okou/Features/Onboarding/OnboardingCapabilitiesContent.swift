import CCStateSwiftUI
import ChatData
import SwiftUI

struct OnboardingCapabilitiesContent: View {
  let store: OnboardingStore
  @LoadableValue private var preferences: Loadable<OnboardingToolPreferences>
  @LoadableValue private var tools: Loadable<[OnboardingTool]>

  init(store: OnboardingStore) {
    self.store = store
    _preferences = LoadableValue(task: store.resources.preferences, keepLast: true)
    _tools = LoadableValue(task: store.resources.tools)
  }

  var body: some View {
    Section {
      switch preferences {
      case .loading: OkouLoadingRow("Loading preferences…")
      case .hasError(let error):
        OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
          store.retry(.preferences)
        }
      case .hasData(let value):
        tool(
          "image-generation", title: "Image generation", detail: "Create and edit images.",
          preferences: value)
        tool(
          "web-search", title: "Web search", detail: "Find current information on the web.",
          preferences: value)
        switch tools {
        case .loading: OkouLoadingRow("Loading tools…")
        case .hasError(let error):
          OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
            store.retry(.tools)
          }
        case .hasData(let families):
          ForEach(families) { family in
            tool(family.id, title: family.title, detail: family.description, preferences: value)
          }
        }
      }
    } footer: {
      Text("Tool usage may use credits. Only the tools you enable are available to Okou.")
        .okouSectionNote()
    }
  }

  private func tool(
    _ id: String, title: String, detail: String, preferences: OnboardingToolPreferences
  ) -> some View {
    Toggle(
      isOn: Binding(
        get: { !preferences.disabledTools.contains(id) },
        set: { value in Task { await store.setTool(id, enabled: value) } })
    ) {
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        Text(title)
        Text(detail).font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
    }
    .tint(OkouColor.primary400)
    .disabled(store.isWorking)
  }
}
