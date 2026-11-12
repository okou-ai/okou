import CCStateSwiftUI
import SwiftUI

/// Rendering and measurement observe the original read phase without demanding hidden cards.
struct PermissionCardReadView<Value: Sendable, Content: View>: View {
  let read: PermissionCardRead<Value>
  @ViewBuilder let content: (Loadable<Value>) -> Content

  var body: some View {
    StoreProvider(read.store) {
      PermissionCardDemandView(read: read, content: content)
    }.id(ObjectIdentifier(read))
  }
}

private struct PermissionCardDemandView<Value: Sendable, Content: View>: View {
  let read: PermissionCardRead<Value>
  let content: (Loadable<Value>) -> Content
  @LoadableValue private var requested: Loadable<Bool>

  init(read: PermissionCardRead<Value>, content: @escaping (Loadable<Value>) -> Content) {
    self.read = read
    self.content = content
    _requested = LoadableValue(read.requested)
  }

  var body: some View {
    switch requested {
    case .hasData(true): PermissionCardValueView(read: read, content: content)
    case .hasError(let error): content(.hasError(error))
    case .loading, .hasData(false): content(.loading)
    }
  }
}

private struct PermissionCardValueView<Value: Sendable, Content: View>: View {
  let content: (Loadable<Value>) -> Content
  @LoadableValue private var value: Loadable<Value>

  init(read: PermissionCardRead<Value>, content: @escaping (Loadable<Value>) -> Content) {
    self.content = content
    _value = LoadableValue(task: read.value)
  }

  var body: some View { content(value) }
}
