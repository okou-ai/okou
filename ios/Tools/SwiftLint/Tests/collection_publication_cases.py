"""CLI contracts for native collection publication after suspension."""

COLLECTION_PUBLICATION_CASES = [
    (
        "owner array methods publish after suspension",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          func refresh() -> Task<Void, Never> {
            Task {
              let value = await service.load()
              items.append(value) // violation
              self.items.insert(value, at: 0) // violation
              items.remove(at: 0) // violation
              items.removeAll() // violation
              items.sort() // violation
              items.reverse() // violation
              items.append(contentsOf: [value]) // violation
            }
          }
        }
        """,
    ),
    (
        "dictionary and set methods publish after suspension",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var values: [String: String] = [:]
          var ids: Swift.Set<String> = []
          func refresh() -> Task<Void, Never> {
            Task {
              let value = await service.load()
              values.updateValue(value, forKey: "current") // violation
              self.values.removeValue(forKey: "old") // violation
              values.merge(["current": value]) { _, new in new } // violation
              ids.insert(value) // violation
              ids.remove(value) // violation
              ids.formUnion([value]) // violation
              ids.subtract([value]) // violation
            }
          }
        }
        """,
    ),
    (
        "qualified optional and grouped collection receivers",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: Swift.Array<String>? = []
          var values: Dictionary<String, String> = [:]
          var buffer: ContiguousArray<String> = []
          func refresh() -> Task<Void, Never> {
            Task { [weak self] in
              let value = await service.load()
              self?.items?.append(value) // violation
              guard let self else { return }
              (self.values).updateValue(value, forKey: "current") // violation
              buffer.append(value) // violation
            }
          }
        }
        """,
    ),
    (
        "collection argument suspension still requires a check",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          func refresh() -> Task<Void, Error> {
            Task {
              self.items.append(try await service.load()) // violation
              try Task.checkCancellation()
              items.append("checked")
              let value = try await service.load()
              items.append(value) // violation
            }
          }
        }
        """,
    ),
    (
        "owner and cancellation guards fence collection publication",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          var values: [String: String] = [:]
          var generation = 0
          var closed = false
          func refresh() -> Task<Void, Error> {
            let request = generation
            return Task {
              let value = try await service.load()
              guard !closed, request == generation else { return }
              items.append(value)
              values.updateValue(value, forKey: "current")
              let next = try await service.load()
              try Task.checkCancellation()
              items.append(next)
            }
          }
        }
        """,
    ),
    (
        "collection checks must fence the continuing path",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          func refresh() -> Task<Void, Error> {
            Task {
              await service.load()
              try? Task.checkCancellation()
              items.append("unchecked") // violation
              if shouldCheck { try Task.checkCancellation() }
              items.append("conditional") // violation
              if Task.isCancelled { return }
              items.append("current")
            }
          }
        }
        """,
    ),
    (
        "local copies and unrelated receiver methods do not publish owner collections",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          var sink: CustomSink
          func refresh() -> Task<Void, Never> {
            Task {
              var items = self.items
              let value = await service.load()
              items.append(value)
              sink.append(value)
              _ = self.items.map { $0.uppercased() }
              _ = self.items.sorted()
              self.items.append(value) // violation
            }
          }
          func parameter(items: CustomSink) -> Task<Void, Never> {
            Task {
              let value = await service.load()
              items.append(value)
            }
          }
        }
        """,
    ),
    (
        "optional loop tuple capture and catch bindings shadow owner collections",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          func refresh() {
            Task { [items = sink] in
              let value = await service.load()
              items.append(value)
            }
            Task {
              if var items = service.cached {
                let value = await service.load()
                items.append(value)
              }
              for var items in service.batches {
                let value = await service.load()
                items.append(value)
              }
              var (items, count) = (self.items, 0)
              let value = await service.load()
              items.append(value)
            }
            Task {
              do { try await service.save() }
              catch let items as CustomError { items.append("diagnostic") }
              catch {}
            }
          }
        }
        """,
    ),
    (
        "case patterns bind local collection copies",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          func refresh() -> Task<Void, Never> {
            Task {
              switch service.cached {
              case .some(var items):
                let value = await service.load()
                items.append(value)
              default: break
              }
              if case .some(var items) = service.cached {
                let value = await service.load()
                items.append(value)
              }
              guard case .some(var items) = service.cached else { return }
              let value = await service.load()
              items.append(value)
              self.items.append(value) // violation
            }
          }
        }
        """,
    ),
    (
        "task handle collections and deferred cleanup keep their native lifetime",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          var retired: [Task<Void, Never>] = []
          var subscriptions: [String: CCState.Subscription] = [:]
          func finish() -> Task<Void, Never> {
            Task {
              defer { self.items.removeAll() }
              await service.finish()
              retired.append(cleanup)
              subscriptions.removeAll()
            }
          }
        }
        """,
    ),
    (
        "collection spelling without a known owner type remains a review boundary",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items = ["initial"]
          var alias: BusinessValues
          var foreign: ForeignOwner
          func refresh() -> Task<Void, Never> {
            Task {
              let value = await service.load()
              items.append(value)
              alias.append(value)
              foreign.items.append(value)
            }
          }
        }
        """,
    ),
    (
        "graph callbacks apply the same collection publication contract",
        "okou_check_after_await",
        """
        import CCState
        final class Owner {
          var items: [String] = []
          lazy var save = asyncCommand { context, value in
            await service.save(value)
            self.items.append(value) // violation
          }
          lazy var read = computedTask { get, options in
            let value = await service.load()
            try options.signal.checkCancellation()
            self.items.append(value)
            return value
          }
        }
        """,
    ),
]
