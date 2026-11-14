import SwiftSyntax

/// Direct mutations of explicitly typed native value collections, not arbitrary append-like APIs.
struct NativeCollectionMutation {
  private enum Kind {
    case array, dictionary, set

    init?(_ type: TypeSyntax) {
      if let optional = type.as(OptionalTypeSyntax.self) {
        self.init(optional.wrappedType)
      } else if let optional = type.as(ImplicitlyUnwrappedOptionalTypeSyntax.self) {
        self.init(optional.wrappedType)
      } else if type.is(ArrayTypeSyntax.self) {
        self = .array
      } else if type.is(DictionaryTypeSyntax.self) {
        self = .dictionary
      } else {
        let name: String
        if let identifier = type.as(IdentifierTypeSyntax.self),
          identifier.genericArgumentClause != nil
        {
          name = identifier.name.text
        } else if let member = type.as(MemberTypeSyntax.self),
          member.baseType.trimmedDescription == "Swift", member.genericArgumentClause != nil
        {
          name = member.name.text
        } else {
          return nil
        }
        switch name {
        case "Array", "ContiguousArray": self = .array
        case "Dictionary": self = .dictionary
        case "Set": self = .set
        default: return nil
        }
      }
    }

    func mutates(_ name: String) -> Bool {
      switch self {
      case .array:
        return [
          "append", "insert", "remove", "removeAll", "removeFirst", "removeLast",
          "popLast", "removeSubrange", "replaceSubrange", "sort", "reverse", "shuffle",
          "swapAt", "partition",
        ].contains(name)
      case .dictionary:
        return ["updateValue", "merge", "removeValue", "removeAll", "popFirst"].contains(name)
      case .set:
        return [
          "insert", "update", "remove", "removeAll", "popFirst", "formUnion",
          "formIntersection", "formSymmetricDifference", "subtract",
        ].contains(name)
      }
    }
  }

  private let properties: [String: Kind]

  init(owner: MemberBlockSyntax?, publishing: Set<String>) {
    var properties: [String: Kind] = [:]
    for member in owner?.members ?? [] {
      guard let declaration = member.decl.as(VariableDeclSyntax.self),
        declaration.bindingSpecifier.text == "var"
      else { continue }
      for binding in declaration.bindings {
        guard let name = binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text,
          publishing.contains(name), let type = binding.typeAnnotation?.type,
          let kind = Kind(type)
        else { continue }
        properties[name] = kind
      }
    }
    self.properties = properties
  }

  func contains(_ member: MemberAccessExprSyntax, locals: Set<String>) -> Bool {
    guard let base = member.base else { return false }
    let receiver = unwrapped(base)
    let name: String
    let explicitSelf: Bool
    if let field = receiver.as(MemberAccessExprSyntax.self), let owner = field.base,
      unwrapped(owner).trimmedDescription == "self"
    {
      name = field.declName.baseName.text
      explicitSelf = true
    } else if let reference = receiver.as(DeclReferenceExprSyntax.self) {
      name = reference.baseName.text
      explicitSelf = false
    } else {
      return false
    }
    guard properties[name]?.mutates(member.declName.baseName.text) == true else { return false }
    return explicitSelf
      || !locals.contains(name)
        && NativeLifetimeIndex.resolve(receiver).identity == "self." + name
        && !shadowed(name, at: receiver)
  }

  private func unwrapped(_ expression: ExprSyntax) -> ExprSyntax {
    if let optional = expression.as(OptionalChainingExprSyntax.self) {
      return unwrapped(optional.expression)
    }
    if let forced = expression.as(ForceUnwrapExprSyntax.self) {
      return unwrapped(forced.expression)
    }
    if let tuple = expression.as(TupleExprSyntax.self), tuple.elements.count == 1,
      let element = tuple.elements.first, element.label == nil
    {
      return unwrapped(element.expression)
    }
    return expression
  }

  private func shadowed(_ name: String, at node: ExprSyntax) -> Bool {
    // The key resolver covers parameters, loops, and optional bindings. Also preserve
    // tuple locals, catch bindings, and capture-list snapshots of a value collection.
    for parent in ancestors(of: node) {
      if parent.is(MemberBlockSyntax.self) { break }
      if let statements = parent.as(CodeBlockItemListSyntax.self) {
        for item in statements where item.position < node.position {
          if let guardStatement = item.item.as(GuardStmtSyntax.self),
            node.position >= guardStatement.endPosition,
            binds(guardStatement.conditions, name: name)
          {
            return true
          }
          guard let declaration = item.item.as(VariableDeclSyntax.self) else { continue }
          for binding in declaration.bindings
          where nativeLifetimeBindings(binding.pattern).contains(name) {
            if binding.initializer.map({
              $0.position <= node.position && node.position < $0.endPosition
            }) != true {
              return true
            }
          }
        }
      }
      if let handler = parent.as(CatchClauseSyntax.self),
        handler.catchItems.contains(where: {
          $0.pattern.map { binds(Syntax($0), name: name) } == true
        })
      {
        return true
      }
      if let branch = parent.as(SwitchCaseSyntax.self),
        let label = branch.label.as(SwitchCaseLabelSyntax.self),
        label.caseItems.contains(where: { binds(Syntax($0.pattern), name: name) })
      {
        return true
      }
      if let branch = parent.as(IfExprSyntax.self),
        branch.body.position <= node.position && node.endPosition <= branch.body.endPosition,
        binds(branch.conditions, name: name)
      {
        return true
      }
      if let loop = parent.as(WhileStmtSyntax.self),
        loop.body.position <= node.position && node.endPosition <= loop.body.endPosition,
        binds(loop.conditions, name: name)
      {
        return true
      }
      if let closure = parent.as(ClosureExprSyntax.self),
        closure.signature?.capture?.items.contains(where: { $0.name.text == name }) == true
      {
        return true
      }
    }
    return false
  }

  private func binds(_ conditions: ConditionElementListSyntax, name: String) -> Bool {
    conditions.contains {
      let pattern =
        $0.condition.as(OptionalBindingConditionSyntax.self)?.pattern
        ?? $0.condition.as(MatchingPatternConditionSyntax.self)?.pattern
      return pattern.map { binds(Syntax($0), name: name) } == true
    }
  }

  private func binds(_ node: Syntax, name: String) -> Bool {
    if let identifier = node.as(IdentifierPatternSyntax.self) {
      return identifier.identifier.text == name
    }
    return node.children(viewMode: .sourceAccurate).contains { binds($0, name: name) }
  }
}
