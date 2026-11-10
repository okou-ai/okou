import SwiftLintCore
import SwiftSyntax

struct PrivateAtomsRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_private_atoms", name: "Private mutable graph atoms",
    description:
      "Keep mutable CCState atoms private to their owner; expose reads and semantic actions",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
      guard !hasPrivateAccess(node.modifiers), !isPrivate(node),
        node.parent?.is(MemberBlockItemSyntax.self) == true
          || node.parent?.parent?.parent?.is(SourceFileSyntax.self) == true
      else { return .visitChildren }
      for binding in node.bindings {
        let explicitAtom =
          binding.typeAnnotation.map { containsGraphType($0.type, names: ["State"]) } ?? false
        let initializedAtom =
          binding.initializer?.value.as(FunctionCallExprSyntax.self)
          .map { isGraphCall($0, names: ["State"]) } ?? false
        if explicitAtom || initializedAtom {
          positions.append(binding.positionAfterSkippingLeadingTrivia)
        }
      }
      return .visitChildren
    }

    override func visit(_ node: FunctionDeclSyntax) -> SyntaxVisitorContinueKind {
      guard !hasPrivateAccess(node.modifiers), !isPrivate(node),
        let type = node.signature.returnClause?.type, containsGraphType(type, names: ["State"])
      else { return .visitChildren }
      positions.append(node.positionAfterSkippingLeadingTrivia)
      return .visitChildren
    }
  }
}
