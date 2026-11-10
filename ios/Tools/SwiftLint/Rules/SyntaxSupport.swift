import Foundation
import SwiftLintCore
import SwiftSyntax

// All rules operate on syntax only. Unknown types and cross-file helper bodies
// remain review responsibilities; these checks never load SourceKit.
protocol NativeRule: SourceKitFreeRule, OptInRule
where ConfigurationType: SeverityBasedRuleConfiguration {}

extension NativeRule {
  func findings(_ positions: [AbsolutePosition], in file: SwiftLintFile) -> [StyleViolation] {
    positions.map {
      StyleViolation(
        ruleDescription: Self.description, severity: configuration.severity,
        location: Location(file: file, position: $0))
    }
  }
}

func callName(_ expression: ExprSyntax) -> String {
  if let reference = expression.as(DeclReferenceExprSyntax.self) {
    return reference.baseName.text
  }
  if let member = expression.as(MemberAccessExprSyntax.self) {
    return member.declName.baseName.text
  }
  if let generic = expression.as(GenericSpecializationExprSyntax.self) {
    return callName(generic.expression)
  }
  return ""
}

func ancestors(of node: some SyntaxProtocol) -> [Syntax] {
  var result: [Syntax] = []
  var parent = node.parent
  while let current = parent {
    result.append(current)
    parent = current.parent
  }
  return result
}

func hasPrivateAccess(_ modifiers: DeclModifierListSyntax) -> Bool {
  modifiers.contains { ["private", "fileprivate"].contains($0.name.text) && $0.detail == nil }
}

func isPrivate(_ declaration: some SyntaxProtocol) -> Bool {
  ancestors(of: declaration).contains {
    if let type = $0.as(ClassDeclSyntax.self) { return hasPrivateAccess(type.modifiers) }
    if let type = $0.as(StructDeclSyntax.self) { return hasPrivateAccess(type.modifiers) }
    if let type = $0.as(EnumDeclSyntax.self) { return hasPrivateAccess(type.modifiers) }
    if let type = $0.as(ActorDeclSyntax.self) { return hasPrivateAccess(type.modifiers) }
    if let type = $0.as(ExtensionDeclSyntax.self) { return hasPrivateAccess(type.modifiers) }
    return false
  }
}

func closureCall(_ closure: ClosureExprSyntax) -> (FunctionCallExprSyntax, String)? {
  if let call = closure.parent?.as(FunctionCallExprSyntax.self) { return (call, "") }
  if let argument = closure.parent?.as(LabeledExprSyntax.self),
    let call = argument.parent?.parent?.as(FunctionCallExprSyntax.self)
  {
    return (call, argument.label?.text ?? "")
  }
  if let argument = closure.parent?.as(MultipleTrailingClosureElementSyntax.self),
    let call = argument.parent?.parent?.as(FunctionCallExprSyntax.self)
  {
    return (call, argument.label.text)
  }
  return nil
}

let graphConstructors: Set<String> = [
  "State", "Computed", "Command", "Store", "computedTask", "asyncCommand",
]
let graphCallbacks: Set<String> = ["Computed", "Command", "computedTask", "asyncCommand"]

func isGraphCall(_ call: FunctionCallExprSyntax, names: Set<String>) -> Bool {
  guard names.contains(callName(call.calledExpression)) else { return false }
  var expression = call.calledExpression
  if let generic = expression.as(GenericSpecializationExprSyntax.self) {
    expression = generic.expression
  }
  if let member = expression.as(MemberAccessExprSyntax.self) {
    return member.base?.trimmedDescription == "CCState"
  }
  return true
}

func hasCCState(_ file: SwiftLintFile) -> Bool {
  file.syntaxTree.statements.contains {
    $0.item.as(ImportDeclSyntax.self)?.path.first?.name.text == "CCState"
  }
}

// A builder's content executes during projection; event/lifecycle callbacks do
// not. Unknown callbacks are kept in render scope rather than silently skipped.
func isDeferred(_ closure: ClosureExprSyntax) -> Bool {
  if closure.parent?.is(InitializerClauseSyntax.self) == true { return true }
  if let assignment = closure.parent?.as(SequenceExprSyntax.self)
    ?? closure.parent?.parent?.as(SequenceExprSyntax.self),
    assignment.elements.contains(where: { $0.is(AssignmentExprSyntax.self) })
  {
    return true
  }
  guard let (call, label) = closureCall(closure) else { return false }
  let actionLabels: Set<String> = [
    "action", "perform", "completion", "handler", "set", "dismiss", "cancel", "save", "close",
    "retry", "choose", "showDetails", "moveToProject", "changed", "ended", "loadingChanged",
  ]
  if actionLabels.contains(label) || label.hasPrefix("on") || label.hasPrefix("did") {
    return true
  }
  let name = callName(call.calledExpression)
  if name == "Button", label.isEmpty, call.arguments.contains(where: { $0.label?.text == "action" })
  {
    return false  // An explicit action makes the trailing closure the label builder.
  }
  let callbacks: Set<String> = [
    "task", "onAppear", "onDisappear", "onChange", "onReceive", "onSubmit", "onCancel",
    "onTapGesture", "onLongPressGesture", "refreshable", "onOpenURL", "onContinueUserActivity",
    "signOutConfirmation",
  ]
  if callbacks.contains(name) { return true }
  // These shared controls' trailing parameters are actions, not ViewBuilders.
  // OkouBanner's trailing `actions` is a ViewBuilder and stays in render scope.
  let trailingActions: Set<String> = [
    "Button", "Task", "asyncCommand", "Command", "OkouCloseButton", "OkouCloseToolbarItem",
    "OkouChip", "OkouActionRow", "OkouLoadErrorRow", "ChatSyncStatusView", "ConnectorSafariView",
    "ComposerAddSheet", "UIAction",
  ]
  if label.isEmpty && trailingActions.contains(name) {
    return true
  }
  return false
}

func rootName(_ expression: ExprSyntax) -> String {
  expression.trimmedDescription.components(separatedBy: ".").first ?? ""
}

func isLocalProjectionValue(_ name: String, at node: some SyntaxProtocol) -> Bool {
  for ancestor in ancestors(of: node) {
    guard let statements = ancestor.as(CodeBlockItemListSyntax.self) else { continue }
    for statement in statements.reversed() where statement.position < node.position {
      guard let declaration = statement.item.as(VariableDeclSyntax.self),
        declaration.bindingSpecifier.text == "var"
      else { continue }
      for binding in declaration.bindings
      where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
        guard let value = binding.initializer?.value else { return false }
        if let call = value.as(FunctionCallExprSyntax.self) {
          let constructor = callName(call.calledExpression).first?.isUppercase == true
          let configuration =
            call.calledExpression.as(MemberAccessExprSyntax.self)?.base?
            .trimmedDescription.hasSuffix(".Configuration") == true
          return constructor || configuration
        }
        // UIKit supplies a value-type AttributeContainer to this transformer.
        return value.trimmedDescription == name
          && ancestors(of: declaration).contains {
            guard let closure = $0.as(ClosureExprSyntax.self) else { return false }
            return closureCall(closure).map { callName($0.0.calledExpression) }
              == "UIConfigurationTextAttributesTransformer"
          }
      }
    }
  }
  return false
}

// Native update callbacks project into their supplied control/coordinator. Track
// aliases of those parameters without permitting mutations of business owners.
final class ProjectionNames: SyntaxVisitor {
  var names: Set<String>
  init(function: FunctionDeclSyntax) {
    names = Set(
      function.signature.parameterClause.parameters.map { ($0.secondName ?? $0.firstName).text })
    super.init(viewMode: .sourceAccurate)
  }
  override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
    for binding in node.bindings {
      if let value = binding.initializer?.value, names.contains(rootName(value)),
        let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
      {
        names.insert(name)
      }
    }
    return .visitChildren
  }
}

func isRender(_ node: some SyntaxProtocol) -> Bool {
  for parent in ancestors(of: node) {
    if let closure = parent.as(ClosureExprSyntax.self), isDeferred(closure) { return false }
    if let function = parent.as(FunctionDeclSyntax.self) {
      if ["updateUIView", "updateUIViewController"].contains(function.name.text) { return true }
      return function.attributes.contains { $0.trimmedDescription == "@ViewBuilder" }
    }
    if let binding = parent.as(PatternBindingSyntax.self),
      binding.accessorBlock != nil,
      let type = binding.typeAnnotation?.type.trimmedDescription,
      type.hasPrefix("some View") || type.hasPrefix("some SwiftUI.View")
        || type.hasPrefix("some ToolbarContent") || type.hasPrefix("some Scene")
    {
      return true
    }
  }
  return false
}

func closureParameters(_ closure: ClosureExprSyntax) -> [String] {
  guard let clause = closure.signature?.parameterClause else { return [] }
  switch clause {
  case .simpleInput(let parameters): return parameters.map { $0.name.text }
  case .parameterClause(let parameters):
    return parameters.parameters.map { ($0.secondName ?? $0.firstName).text }
  }
}

final class NameCollector: SyntaxVisitor {
  var stores: Set<String> = []
  var setters: Set<String> = []
  var sessions: Set<String> = []
  var clients: Set<String> = []

  override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
    for binding in node.bindings {
      guard let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text else {
        continue
      }
      let type = binding.typeAnnotation?.type.trimmedDescription ?? ""
      let value = binding.initializer?.value.trimmedDescription ?? ""
      if ["Store", "CCState.Store"].contains(type) || value.hasPrefix("CCState.Store(")
        || value.hasPrefix("Store(")
      {
        stores.insert(name)
      }
      let sourceName = value.components(separatedBy: ".").last ?? ""
      if type.contains("URLSession") || value.hasPrefix("URLSession")
        || value.hasPrefix("Foundation.URLSession")
        || sessions.contains(sourceName)
      {
        sessions.insert(name)
      }
      if type == "APIClient" || value.hasPrefix("APIClient(") { clients.insert(name) }
      if node.attributes.contains(where: {
        guard let attribute = $0.as(AttributeSyntax.self) else { return false }
        let name =
          attribute.attributeName.as(IdentifierTypeSyntax.self)?.name.text
          ?? attribute.attributeName.as(MemberTypeSyntax.self)?.name.text ?? ""
        return ["SignalSetter", "CommandSetter", "State", "Binding", "FocusState"].contains(name)
      }) {
        setters.insert(name)
      }
    }
    return .visitChildren
  }

  override func visit(_ node: FunctionParameterSyntax) -> SyntaxVisitorContinueKind {
    if node.type.trimmedDescription == "URLSession" {
      sessions.insert((node.secondName ?? node.firstName).text)
    }
    if node.type.trimmedDescription == "APIClient" {
      clients.insert((node.secondName ?? node.firstName).text)
    }
    return .visitChildren
  }
}

func caughtError(_ node: CatchClauseSyntax) -> String? {
  if node.catchItems.isEmpty { return "error" }
  guard node.catchItems.count == 1, let item = node.catchItems.first, item.whereClause == nil,
    let binding = item.pattern?.as(ValueBindingPatternSyntax.self)
  else { return nil }
  return binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text
}

func containsAccessor(_ type: TypeSyntax) -> Bool {
  containsGraphType(type, names: ["Getter", "CommandContext"])
}

func containsGraphType(_ type: TypeSyntax, names: Set<String>) -> Bool {
  let visitor = GraphTypes(names: names)
  visitor.walk(type)
  return visitor.found
}

private final class GraphTypes: SyntaxVisitor {
  let names: Set<String>
  var found = false
  init(names: Set<String>) {
    self.names = names
    super.init(viewMode: .sourceAccurate)
  }
  override func visit(_ node: IdentifierTypeSyntax) -> SyntaxVisitorContinueKind {
    if names.contains(node.name.text) { found = true }
    return .visitChildren
  }
  override func visit(_ node: MemberTypeSyntax) -> SyntaxVisitorContinueKind {
    if node.baseType.trimmedDescription == "CCState", names.contains(node.name.text) {
      found = true
    }
    // The qualifier is not itself the value type (State<T>.Type is a
    // metatype), but generic arguments may expose a scoped capability.
    for argument in node.genericArgumentClause?.arguments ?? [] { walk(argument.argument) }
    return .skipChildren
  }
}
