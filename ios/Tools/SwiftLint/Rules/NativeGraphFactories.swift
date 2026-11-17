import SwiftSyntax

final class NativeGraphFactories {
  private let factories: NativeFreshFactories

  init(tree: SourceFileSyntax) {
    factories = NativeFreshFactories(
      tree: tree, type: Self.graphType, construction: Self.construction)
  }

  func constructsGraph(_ call: FunctionCallExprSyntax) -> Bool {
    factories.constructs(call)
  }

  private static func graphType(_ type: TypeSyntax) -> Bool {
    let name: String
    if let identifier = type.as(IdentifierTypeSyntax.self) {
      name = identifier.name.text
    } else if let member = type.as(MemberTypeSyntax.self),
      member.baseType.trimmedDescription == "CCState"
    {
      name = member.name.text
    } else {
      return false
    }
    return graphConstructors.union(["Signal"]).contains(name)
  }

  private static func construction(_ expression: ExprSyntax) -> Bool {
    if let attempt = expression.as(TryExprSyntax.self), attempt.questionOrExclamationMark == nil {
      return construction(attempt.expression)
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first, element.label == nil
    {
      return construction(element.expression)
    }
    return expression.as(FunctionCallExprSyntax.self).map {
      isGraphCall($0, names: graphConstructors)
    } == true
  }

}
