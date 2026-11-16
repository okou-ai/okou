"""Resource Task constructors and cancellation captures retain their lexical owner."""

RESOURCE_CANCELLATION_BINDING_CASES = [
    (
        "explicit operation Tasks require evaluation cancellation",
        "okou_resource_cancellation",
        """
        import CCState
        let missing = Computed { get, options in
          let task = Task(operation: { try await service.load() }) // violation
          return task
        }
        let connected = Computed { get, options in
          let task = Task(operation: { try await service.load() })
          options.signal.onCancel { task.cancel() }
          return task
        }
        let synchronous = Computed { get, options in
          let task = Task(operation: { cached })
          return task
        }
    """,
    ),
    (
        "foreign cancellation captures cannot release the resource Task",
        "okou_resource_cancellation",
        """
        import CCState
        let foreign = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { [task = otherTask] in task.cancel() }
          return task
        }
        let indirect = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { [task = makeOtherTask()] in task.cancel() }
          return task
        }
    """,
    ),
    (
        "capture snapshots can cancel the original resource Task",
        "okou_resource_cancellation",
        """
        import CCState
        let renamed = Computed { get, options in
          let task = Task { try await service.load() }
          options.signal.onCancel { [request = task] in request.cancel() }
          return task
        }
        let grouped = Computed { get, options in
          let task = Task { try await service.load() }
          options.signal.onCancel { [request = (task)] in request.cancel() }
          return task
        }
        let shorthand = Computed { get, options in
          let task = Task { try await service.load() }
          options.signal.onCancel { [task] in task.cancel() }
          return task
        }
    """,
    ),
    (
        "capture initializers resolve in the enclosing scope",
        "okou_resource_cancellation",
        """
        import CCState
        let original = Computed { get, options in
          let task = Task { try await service.load() }
          options.signal.onCancel { [task = otherTask, request = task] in
            request.cancel()
          }
          return task
        }
        let foreign = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { [task = otherTask, request = task] in
            task.cancel()
          }
          return task
        }
    """,
    ),
    (
        "handler locals retain their scope over captured Task snapshots",
        "okou_resource_cancellation",
        """
        import CCState
        let shadowed = Computed { get, options in
          let task = Task { try await service.load() } // violation
          options.signal.onCancel { [request = task] in
            let request = otherTask
            request.cancel()
          }
          return task
        }
        let aliased = Computed { get, options in
          let task = Task { try await service.load() }
          options.signal.onCancel { [request = task] in
            let original = (request)
            original.cancel()
          }
          return task
        }
    """,
    ),
]
