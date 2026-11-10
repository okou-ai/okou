import SwiftLintCore
import SwiftSyntax

struct AccessorEscapeRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_accessor_escape", name: "Scoped graph accessors",
    description: "Do not store, return, or pass graph accessors to ordinary helpers", kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: FunctionParameterSyntax) -> SyntaxVisitorContinueKind {
      if containsAccessor(node.type) {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    override func visit(_ node: DeclReferenceExprSyntax) -> SyntaxVisitorContinueKind {
      let name = node.baseName.text
      var escaped = false
      for parent in ancestors(of: node) {
        guard let closure = parent.as(ClosureExprSyntax.self) else { continue }
        let parameters = closureParameters(closure)
        guard parameters.contains(name) else {
          if isDeferred(closure) { escaped = true }
          continue
        }
        guard let (call, _) = closureCall(closure), isGraphCall(call, names: graphCallbacks),
          parameters.first == name
        else { return .visitChildren }
        let primitive = callName(call.calledExpression)
        let command = ["Command", "asyncCommand"].contains(primitive)
        let directRead =
          node.parent?.as(FunctionCallExprSyntax.self)?.calledExpression.id == node.id
        let member = node.parent?.as(MemberAccessExprSyntax.self)
        let directCommand =
          member.map {
            ["get", "set"].contains($0.declName.baseName.text)
              && $0.parent?.as(FunctionCallExprSyntax.self)?.calledExpression.id == $0.id
          } ?? false
        if escaped || !(command ? directCommand : directRead) {
          positions.append(node.positionAfterSkippingLeadingTrivia)
        }
        return .visitChildren
      }
      return .visitChildren
    }
  }
}
