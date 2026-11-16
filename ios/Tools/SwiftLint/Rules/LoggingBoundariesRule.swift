import Foundation
import SwiftLintCore
import SwiftSyntax

struct LoggingBoundariesRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_logging_boundaries", name: "Native diagnostic logging",
    description: "Use OSLog.Logger instead of raw console diagnostics in production sources",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard let path = file.path?.path,
      let root = path.range(of: "/ios/", options: .backwards)
    else { return [] }
    let source = path[root.upperBound...]
    guard
      [
        "Okou/", "Push/", "Widgets/", "Packages/ChatDomain/Sources/ChatDomain/",
        "Packages/ChatData/Sources/ChatData/",
      ].contains(where: { source.hasPrefix($0) })
    else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []
    private let swiftOutput: Set<String> = ["print", "debugPrint", "dump"]

    override func visit(_ node: MacroExpansionDeclSyntax) -> SyntaxVisitorContinueKind {
      node.macroName.text == "Preview" ? .skipChildren : .visitChildren
    }

    override func visit(_ node: MacroExpansionExprSyntax) -> SyntaxVisitorContinueKind {
      node.macroName.text == "Preview" ? .skipChildren : .visitChildren
    }

    override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
      if let member = node.parent?.as(MemberAccessExprSyntax.self), member.declName.id == node.id {
        return .visitChildren
      }
      let name = node.baseName.text
      if swiftOutput.union(["NSLog", "os_log"]).contains(name),
        !shadowed(name, at: node), !directedOutput(ExprSyntax(node), reference: node)
      {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    override func visit(_ node: MemberAccessExprSyntax) -> SyntaxVisitorContinueKind {
      guard let module = node.base?.as(DeclReferenceExprSyntax.self)?.baseName.text else {
        return .visitChildren
      }
      let name = node.declName.baseName.text
      let diagnostic =
        module == "Swift" && swiftOutput.contains(name)
        || module == "Foundation" && name == "NSLog"
        || ["os", "OSLog"].contains(module) && name == "os_log"
      if diagnostic, !shadowed(module, at: node),
        !directedOutput(ExprSyntax(node), reference: node.declName)
      {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func directedOutput(_ node: ExprSyntax, reference: DeclReferenceExprSyntax) -> Bool {
      guard swiftOutput.contains(reference.baseName.text) else { return false }
      if reference.argumentNames?.arguments.contains(where: { $0.name.text == "to" }) == true {
        return true
      }
      guard let call = node.parent?.as(FunctionCallExprSyntax.self),
        call.calledExpression.id == node.id
      else { return false }
      // An explicitly supplied TextOutputStream is output owned by its caller,
      // not an implicit console diagnostic. Business overloads retain their labels.
      let labels: Set<String> =
        reference.baseName.text == "dump"
        ? ["to", "name", "indent", "maxDepth", "maxItems"] : ["to", "separator", "terminator"]
      return call.arguments.contains { $0.label?.text == "to" }
        || call.arguments.contains { $0.label.map { !labels.contains($0.text) } == true }
    }

    private func shadowed(_ name: String, at node: some SyntaxProtocol) -> Bool {
      for scope in ancestors(of: node) {
        if let function = scope.as(FunctionDeclSyntax.self),
          function.signature.parameterClause.parameters.contains(where: {
            ($0.secondName ?? $0.firstName).text == name
          })
        {
          return true
        }
        if let closure = scope.as(ClosureExprSyntax.self),
          node.position >= closure.statements.position
        {
          if closureParameters(closure).contains(name) { return true }
          if closure.signature?.capture?.items.contains(where: {
            $0.name.text == name
          }) == true {
            return true
          }
        }
        if let loop = scope.as(ForStmtSyntax.self), node.position >= loop.body.position,
          nativeLifetimeBindings(loop.pattern).contains(name)
        {
          return true
        }
        if let condition = scope.as(IfExprSyntax.self), node.position >= condition.body.position,
          node.position < condition.body.endPosition,
          bound(name, in: condition.conditions)
        {
          return true
        }
        if let statements = scope.as(CodeBlockItemListSyntax.self) {
          for item in statements {
            if let declaration = item.item.as(DeclSyntax.self),
              !(declaration.is(VariableDeclSyntax.self)
                && statements.parent?.is(SourceFileSyntax.self) != true
                && item.position >= node.position),
              declares(name, declaration)
            {
              return true
            }
            if let guardStatement = item.item.as(GuardStmtSyntax.self),
              guardStatement.endPosition <= node.position,
              bound(name, in: guardStatement.conditions)
            {
              return true
            }
          }
        }
        if let members = scope.as(MemberBlockSyntax.self),
          members.members.contains(where: { declares(name, $0.decl) })
        {
          return true
        }
      }
      return false
    }

    private func bound(_ name: String, in conditions: ConditionElementListSyntax) -> Bool {
      conditions.contains {
        $0.condition.as(OptionalBindingConditionSyntax.self).map {
          nativeLifetimeBindings($0.pattern).contains(name)
        } == true
      }
    }

    private func declares(_ name: String, _ declaration: DeclSyntax) -> Bool {
      if let variable = declaration.as(VariableDeclSyntax.self) {
        return variable.bindings.contains { nativeLifetimeBindings($0.pattern).contains(name) }
      }
      return declaration.as(FunctionDeclSyntax.self)?.name.text == name
        || declaration.as(StructDeclSyntax.self)?.name.text == name
        || declaration.as(ClassDeclSyntax.self)?.name.text == name
        || declaration.as(EnumDeclSyntax.self)?.name.text == name
        || declaration.as(ActorDeclSyntax.self)?.name.text == name
        || declaration.as(TypeAliasDeclSyntax.self)?.name.text == name
    }
  }
}
