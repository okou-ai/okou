import Foundation

public enum SnapshotRenderer {
  private static let roles = [
    "AXButton": "button", "AXCheckBox": "checkbox", "AXComboBox": "combo box",
    "AXDisclosureTriangle": "disclosure triangle", "AXGroup": "container", "AXHeading": "heading",
    "AXImage": "image", "AXLink": "link", "AXList": "list", "AXMenu": "menu",
    "AXMenuBar": "menu bar", "AXMenuBarItem": "menu bar item", "AXMenuItem": "menu item",
    "AXOutline": "outline", "AXPopUpButton": "pop up button", "AXRadioButton": "radio button",
    "AXScrollArea": "scroll area", "AXSlider": "slider", "AXStaticText": "text",
    "AXTabGroup": "tab group", "AXTable": "table", "AXTextArea": "text entry area",
    "AXTextField": "text field", "AXToolbar": "toolbar", "AXUnknown": "container",
  ]
  private static let primaryClickRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXDisclosureTriangle", "AXMenuBarItem", "AXMenuItem",
    "AXPopUpButton", "AXRadioButton",
  ]
  private static let menus: Set<String> = ["AXMenu", "AXMenuBar", "AXMenuBarItem", "AXMenuItem"]
  private static func text(_ value: String?, limit: Int = 180) -> String? {
    guard let value else { return nil }
    let normalized = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    guard !normalized.isEmpty else { return nil }
    return normalized.count > limit ? String(normalized.prefix(limit - 3)) + "..." : normalized
  }
  private static func role(_ node: JSONValue) -> String {
    let ax = node["role"].string ?? ""
    if ax == "AXWindow" {
      return node["subrole"].string == "AXDialog" ? "dialog" : "standard window"
    }
    if ax == "AXWebArea" {
      return text(node["roleDescription"].string, limit: 80) ?? "HTML content"
    }
    if let label = roles[ax] { return label }
    if let description = text(node["roleDescription"].string, limit: 80) { return description }
    return ax.isEmpty
      ? "element"
      : ax.replacingOccurrences(of: "AX", with: "").replacingOccurrences(
        of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression
      ).lowercased()
  }
  private static func line(_ node: JSONValue, index: Int, depth: Int) -> String {
    let ax = node["role"].string ?? ""
    let primary = [
      "name", "value", "visibleText", "text", "titleElementText", "description", "placeholderValue",
      "identifier", "url",
    ].compactMap { text(node[$0].string) }.first
    var annotations: [String] = []
    if node["valueSettable"].bool == true {
      annotations.append("settable" + (node["valueType"].string.map { ", " + $0 } ?? ""))
    }
    if node["enabled"].bool == false { annotations.append("disabled") }
    if node["selected"].bool == true {
      annotations.append("selected")
    } else if node["selectable"].bool == true {
      annotations.append("selectable")
    }
    if node["expanded"].bool == true { annotations.append("expanded") }
    if !primaryClickRoles.contains(ax), node["pressable"].bool == true,
      node["clickableKind"].string == "press"
    {
      annotations.append("pressable")
    }
    if node["pickable"].bool == true, node["clickableKind"].string == "pick" {
      annotations.append("pickable")
    }
    if !primaryClickRoles.contains(ax), !["AXStaticText", "AXGroup", "AXUnknown"].contains(ax),
      node["selectable"].bool != true, node["mouseClickable"].bool == true,
      node["clickableKind"].string == "mouse"
    {
      annotations.append("clickable")
    }
    var details: [String] = []
    for (key, label) in [
      ("description", "Description"), ("value", "Value"), ("visibleText", "Visible Text"),
      ("text", "Text"), ("titleElementText", "Title Element"), ("placeholderValue", "Placeholder"),
      ("identifier", "Identifier"), ("url", "URL"), ("help", "Help"),
    ] {
      if let value = text(
        node[key].string, limit: key == "url" ? 240 : key == "identifier" ? 120 : 180),
        value != primary
      {
        details.append(label + ": " + value)
      }
    }
    if let columns = node["columnTitles"].array?.compactMap(\.string),
      let titles = text(columns.joined(separator: ", ")), titles != primary
    {
      details.append("Columns: " + titles)
    }
    let actions = (node["actions"].array?.compactMap(\.string) ?? []).filter { action in
      !["AXPress", "AXShowMenu", "AXScrollToVisible"].contains(action)
        && !(action == "AXPick" && node["clickableKind"].string == "pick")
        && !(menus.contains(ax) && ["AXCancel", "AXPick"].contains(action))
    }.map { $0.hasPrefix("AX") ? String($0.dropFirst(2)) : $0 }
    if !actions.isEmpty { details.append("Secondary Actions: " + actions.joined(separator: ", ")) }
    var output = String(repeating: "\t", count: depth) + "\(index) " + role(node)
    if !annotations.isEmpty { output += " (" + annotations.joined(separator: ", ") + ")" }
    if let primary { output += " " + primary }
    if !details.isEmpty {
      output += (primary == nil ? " " : ", ") + details.joined(separator: ", ")
    }
    return output
  }
  public static func render(_ snapshot: JSONValue) -> String {
    let app =
      snapshot["appPath"].string ?? snapshot["appDisplayName"].string ?? snapshot["app"].string
      ?? ""
    var details: [String] = []
    if let bundle = snapshot["bundleId"].string { details.append("bundleID " + bundle) }
    if let pid = snapshot["pid"].number, let id = Int(exactly: pid) { details.append("pid \(id)") }
    var lines = [
      "Computer Use state", "<app_state>",
      "App=" + app + (details.isEmpty ? "" : " (" + details.joined(separator: ", ") + ")"),
    ]
    if let title = text(snapshot["windowTitle"].string) {
      lines.append(
        "Window: \"" + title + "\", App: " + (snapshot["appDisplayName"].string ?? app) + ".")
    }
    if snapshot["windowOnCurrentSpace"].bool == false {
      lines.append(
        "Window is on another macOS Space. Screenshot capture can still work; the Accessibility tree may be reduced."
      )
    }
    var index = 0
    var focused: String?
    func visit(_ node: JSONValue, depth: Int) {
      let rendered = line(node, index: index, depth: depth)
      if snapshot["focusedElementIndex"].number == Double(index) {
        focused = line(node, index: index, depth: 0)
      }
      lines.append(rendered)
      index += 1
      for child in node["children"].array ?? [] { visit(child, depth: depth + 1) }
    }
    for node in snapshot["elements"].array ?? [] { visit(node, depth: 0) }
    if let focused { lines.append("\nThe focused UI element is " + focused + ".") }
    lines.append("</app_state>")
    return lines.joined(separator: "\n")
  }
}
