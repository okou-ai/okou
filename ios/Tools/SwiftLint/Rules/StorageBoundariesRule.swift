import Foundation
import SwiftLintCore
import SwiftParser
import SwiftSyntax

struct StorageBoundariesRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_storage_boundaries", name: "Owned native preferences",
    description:
      "Keep UserDefaults at persistence owners and AppStorage at registered UI preferences",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let visitor = Visitor(path: file.path?.path ?? "")
    visitor.walk(file.syntaxTree)
    return visitor.violations.map { position, reason in
      StyleViolation(
        ruleDescription: Self.description, severity: configuration.severity,
        location: Location(file: file, position: position), reason: reason)
    }
  }

  private final class Visitor: SyntaxVisitor {
    let path: String
    let ownsDefaults: Bool
    let isTest: Bool
    var violations: [(AbsolutePosition, String)] = []

    init(path: String) {
      self.path = path
      // These existing owners persist project disclosure and notification metadata.
      // A new definition site needs a responsibility review, not a directory exemption.
      ownsDefaults = [
        "/Okou/Features/ChatList/ChatProjectStore.swift",
        "/Okou/Services/NotificationService.swift",
      ].contains { path.hasSuffix($0) }
      isTest = [
        "/OkouTests/", "/Packages/ChatDomain/Tests/", "/Packages/ChatData/Tests/",
        "/Packages/ChatData/Sources/ChatDataTestSupport/",
      ].contains { path.contains($0) }
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
      if let member = node.parent?.as(MemberAccessExprSyntax.self), member.declName.id == node.id {
        return .skipChildren
      }
      let name = spelling(node.baseName)
      if name == "UserDefaults" {
        checkDefaultsReference(ExprSyntax(node))
      } else if name == "AppStorage" {
        report(node, "Declare AppStorage only for a registered native UI preference")
      }
      return .visitChildren
    }

    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
      let name = spelling(node.declName.baseName)
      if name == "UserDefaults", expressionName(node.base) == "Foundation" {
        checkDefaultsReference(ExprSyntax(node))
      } else if name == "AppStorage", expressionName(node.base) == "SwiftUI" {
        report(node, "Declare AppStorage only for a registered native UI preference")
      } else if name == "standard", node.base == nil, isTest,
        contextualDefaults(ExprSyntax(node))
      {
        report(
          node, "Tests must use an explicit isolated UserDefaults suite, not standard defaults")
      }
      return .visitChildren
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      if let member = node.calledExpression.as(MemberAccessExprSyntax.self),
        member.base == nil, spelling(member.declName.baseName) == "init", isTest,
        contextualDefaults(ExprSyntax(node)), !namedSuite(node)
      {
        report(
          node, "Construct UserDefaults only at its persistence owner or in an isolated test suite")
      }
      return .visitChildren
    }

    override func visit(_ node: IdentifierTypeSyntax) -> SyntaxVisitorContinueKind {
      checkType(node, name: spelling(node.name))
      return .visitChildren
    }

    override func visit(_ node: MemberTypeSyntax) -> SyntaxVisitorContinueKind {
      let name = spelling(node.name)
      if (name == "UserDefaults" && typeName(node.baseType) == "Foundation")
        || (name == "AppStorage" && typeName(node.baseType) == "SwiftUI")
      {
        checkType(node, name: name)
      }
      // A qualifier is not an unqualified type use; still inspect generic arguments.
      for argument in node.genericArgumentClause?.arguments ?? [] { walk(argument.argument) }
      return .skipChildren
    }

    override func visit(_ node: AttributeSyntax) -> SyntaxVisitorContinueKind {
      guard ["AppStorage", "SwiftUI.AppStorage"].contains(typeName(node.attributeName))
      else { return .visitChildren }
      if !allowedPreference(node) {
        report(node, "AppStorage is reserved for registered theme and sidebar UI preferences")
      }
      return .skipChildren
    }

    private func checkType(_ node: some SyntaxProtocol, name: String) {
      if name == "UserDefaults", !ownsDefaults {
        let introducesAlias = ancestors(of: node).contains {
          $0.is(TypeAliasDeclSyntax.self) || $0.is(InheritanceClauseSyntax.self)
        }
        if !isTest || introducesAlias {
          report(node, "Keep UserDefaults types and aliases inside their native persistence owner")
        }
      } else if name == "AppStorage" {
        report(node, "Declare AppStorage only for a registered native UI preference")
      }
    }

    private func checkDefaultsReference(_ reference: ExprSyntax) {
      guard !ownsDefaults else { return }
      var constructor = reference
      if let member = reference.parent?.as(MemberAccessExprSyntax.self),
        spelling(member.declName.baseName) == "init"
      {
        constructor = ExprSyntax(member)
      }
      if isTest, let call = constructor.parent?.as(FunctionCallExprSyntax.self),
        call.calledExpression.id == constructor.id, namedSuite(call)
      {
        return
      }
      report(
        reference,
        "Use the native persistence owner; tests may construct an explicit isolated suite")
    }

    private func namedSuite(_ call: FunctionCallExprSyntax) -> Bool {
      guard call.arguments.count == 1, let argument = call.arguments.first,
        argument.label?.text == "suiteName"
      else { return false }
      var expression = argument.expression
      while let group = expression.as(TupleExprSyntax.self), group.elements.count == 1,
        let element = group.elements.first, element.label == nil
      {
        expression = element.expression
      }
      if expression.is(NilLiteralExprSyntax.self) { return false }
      if let literal = expression.as(StringLiteralExprSyntax.self)?.representedLiteralValue {
        return !literal.isEmpty
      }
      return true
    }

    private func contextualDefaults(_ expression: ExprSyntax) -> Bool {
      // Recognize contextually inferred .standard/.init without guessing arbitrary
      // helper parameter types or resolving cross-file declarations.
      var current = Syntax(expression)
      while let parent = current.parent {
        if parent.is(TryExprSyntax.self) || parent.is(ForceUnwrapExprSyntax.self) {
          current = parent
        } else if let element = parent.as(LabeledExprSyntax.self), element.label == nil,
          let group = element.parent?.parent?.as(TupleExprSyntax.self), group.elements.count == 1
        {
          current = Syntax(group)
        } else if parent.is(InitializerClauseSyntax.self),
          let binding = parent.parent?.as(PatternBindingSyntax.self)
        {
          return defaultsType(binding.typeAnnotation?.type)
        } else if let parameter = parent.as(FunctionParameterSyntax.self) {
          return defaultsType(parameter.type)
        } else if parent.is(InitializerClauseSyntax.self),
          let parameter = parent.parent?.as(FunctionParameterSyntax.self)
        {
          return defaultsType(parameter.type)
        } else if parent.is(ReturnStmtSyntax.self) || parent.is(CodeBlockItemSyntax.self) {
          for ancestor in ancestors(of: parent) {
            if let binding = ancestor.as(PatternBindingSyntax.self) {
              return defaultsType(binding.typeAnnotation?.type)
            }
            if let function = ancestor.as(FunctionDeclSyntax.self) {
              return defaultsType(function.signature.returnClause?.type)
            }
            if let closure = ancestor.as(ClosureExprSyntax.self) {
              return defaultsType(closure.signature?.returnClause?.type)
            }
          }
          return false
        } else {
          return false
        }
      }
      return false
    }

    private func defaultsType(_ type: TypeSyntax?) -> Bool {
      guard let type else { return false }
      if let optional = type.as(OptionalTypeSyntax.self) {
        return defaultsType(optional.wrappedType)
      }
      return ["UserDefaults", "Foundation.UserDefaults"].contains(typeName(type))
    }

    private func allowedPreference(_ node: AttributeSyntax) -> Bool {
      guard case .argumentList(let arguments) = node.arguments,
        arguments.count == 1, let key = arguments.first?.expression
      else { return false }
      if path.hasSuffix("/Okou/Features/ChatList/ChatSidebarView.swift") {
        return key.as(StringLiteralExprSyntax.self)?.representedLiteralValue
          == "okou.sidebar.pinnedCollapsed"
      }
      if ["/Okou/App/OkouAppearance.swift", "/Okou/Features/ChatList/ChatSettingsView.swift"]
        .contains(where: { path.hasSuffix($0) })
      {
        return key.as(MemberAccessExprSyntax.self).map {
          expressionName($0.base) == "OkouAppearancePreference"
            && spelling($0.declName.baseName) == "storageKey"
        } == true
      }
      return false
    }

    private func expressionName(_ expression: ExprSyntax?) -> String {
      expression?.as(DeclReferenceExprSyntax.self).map { spelling($0.baseName) } ?? ""
    }

    private func typeName(_ type: TypeSyntax) -> String {
      if let simple = type.as(IdentifierTypeSyntax.self) { return spelling(simple.name) }
      if let member = type.as(MemberTypeSyntax.self) {
        return typeName(member.baseType) + "." + spelling(member.name)
      }
      return ""
    }

    private func spelling(_ token: TokenSyntax) -> String {
      token.text.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
    }

    private func report(_ node: some SyntaxProtocol, _ reason: String) {
      violations.append((node.positionAfterSkippingLeadingTrivia, reason))
    }
  }
}
