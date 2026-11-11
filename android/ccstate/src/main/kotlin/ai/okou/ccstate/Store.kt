package ai.okou.ccstate

import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * Serial graph engine translated from ccstate 6.1.0 (see THIRD_PARTY_NOTICES.md). Call on its
 * creating thread, including continuations and subscription teardown. Deferred/future values remain
 * opaque; no work is launched or cancelled by inspecting a value.
 */
class Store : Getter, AutoCloseable {
    private class Mounted {
        val dependents = linkedSetOf<Computed<*>>()
        val listeners = IdentitySet<() -> Unit>()
    }

    private class Node {
        var value: Any? = null
        var failure: Throwable? = null
        var epoch = -1L
        var verifiedAt = -1L
        var dependencies = linkedMapOf<Signal<*>, Long>()
        var mounted: Mounted? = null
        var evaluation: Evaluation? = null
    }

    private class Mutation {
        val dirty = linkedSetOf<Computed<*>>()
        val oldEpochs = linkedMapOf<Computed<*>, Long?>()
        val sources = linkedSetOf<State<*>>()
        var flushing = false
    }

    private val thread = Thread.currentThread()
    private val nodes = WeakHashMap<Signal<*>, Node>()
    private val changed = linkedSetOf<Signal<*>>()
    private val evaluating = linkedSetOf<Computed<*>>()
    private var writeVersion = 0L
    private var mutation: Mutation? = null
    private var closed = false
    private var entryDepth = 0
    private val cancellationFailures = mutableListOf<Throwable>()

    private fun checkAccess() {
        check(Thread.currentThread() === thread) { "CCState Store accessed from another thread" }
        check(!closed) { "CCState Store is closed" }
    }

    override fun <T> get(signal: Signal<T>): T = publicEntry { value(read(signal)) }

    // Cancellation handlers belong to the retired evaluation. Report their errors only
    // after the current operation/notifications finish; never cache them as a read result.
    // This depth owns error reporting, not write batching or public-set checkpoints.
    private inline fun <T> publicEntry(operation: () -> T): T {
        checkAccess()
        entryDepth += 1
        var failure: Throwable? = null
        try {
            return operation()
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            entryDepth -= 1
            if (entryDepth == 0 && cancellationFailures.isNotEmpty()) {
                val failures = cancellationFailures.toMutableList()
                cancellationFailures.clear()
                failure?.let(failures::add)
                throw ListenerException(failures)
            }
        }
    }

    // Heterogeneous cache erasure is confined here. Nodes are written only by the typed
    // State setter or that exact Computed's callback, and keyed by signal identity.
    @Suppress("UNCHECKED_CAST")
    private fun <T> value(node: Node): T {
        node.failure?.let { throw it }
        return node.value as T
    }

    private fun read(signal: Signal<*>): Node =
        when (signal) {
            is State<*> ->
                nodes.getOrPut(signal) {
                    Node().apply {
                        value = signal.initial
                        epoch = 0
                    }
                }
            is Computed<*> -> readComputed(signal)
        }

    private fun readComputed(signal: Computed<*>): Node {
        check(signal !in evaluating) { "Cyclic CCState computed dependency" }
        val cached = nodes[signal]
        val dirty = mutation?.dirty?.contains(signal) == true
        if (cached != null) {
            if (!dirty && (cached.mounted != null || cached.verifiedAt == writeVersion))
                return cached
            if (
                cached.dependencies.all { (dependency, epoch) -> read(dependency).epoch == epoch }
            ) {
                cached.verifiedAt = writeVersion
                mutation?.dirty?.remove(signal)
                return cached
            }
        }
        check(evaluating.add(signal)) { "Cyclic CCState computed dependency" }
        try {
            return evaluate(signal, cached ?: Node().also { nodes[signal] = it })
        } finally {
            evaluating.remove(signal)
        }
    }

    private fun evaluate(signal: Computed<*>, node: Node): Node {
        val version = writeVersion
        val previousEpoch = node.epoch
        val wasDirty = mutation?.dirty?.contains(signal) == true
        val previousDependencies = node.dependencies
        val dependencies = linkedMapOf<Signal<*>, Long>()
        node.dependencies = dependencies
        val previousEvaluation = node.evaluation
        val evaluation = Evaluation()
        node.evaluation = evaluation
        val weakSignal = WeakReference(signal)
        val weakNode = WeakReference(node)
        val getter =
            object : Getter {
                override fun <T> get(signal: Signal<T>): T = publicEntry {
                    val dependency = read(signal)
                    val owner = weakNode.get()
                    val definition = weakSignal.get()
                    if (owner?.dependencies === dependencies && definition != null) {
                        dependencies[signal] = dependency.epoch
                        if (owner.mounted != null) mount(signal).dependents.add(definition)
                    }
                    value(dependency)
                }
            }
        var result: Any? = null
        var failure: Throwable? = null
        previousEvaluation?.let { cancellationFailures.addAll(it.invalidate()) }
        try {
            result = signal.read(getter, evaluation)
        } catch (error: Throwable) {
            failure = error
        }
        mutation?.dirty?.remove(signal)
        for (dependency in previousDependencies.keys.toList()) {
            if (!dependencies.containsKey(dependency)) {
                nodes[dependency]?.mounted?.dependents?.remove(signal)
                unmount(dependency)
            }
        }
        val same =
            if (failure != null) {
                node.failure === failure
            } else {
                node.epoch >= 0 && node.failure == null && strictEqual(node.value, result)
            }
        if (!same) {
            node.value = result
            node.failure = failure
            node.epoch += 1
        }
        if (wasDirty && previousEpoch != node.epoch) changed.add(signal)
        node.verifiedAt = version
        return node
    }

    fun <T> set(state: State<T>, value: T) = publicWrite { setState(state, value) }

    fun <T> update(state: State<T>, updater: (T) -> T) = publicWrite {
        setState(state, updater(get(state)))
    }

    fun <I, O> set(command: Command<I, O>, input: I): O = publicWrite { invoke(command, input) }

    private fun <T> publicWrite(write: () -> T): T = publicEntry {
        val size = changed.size
        try {
            write()
        } finally {
            if (changed.size != size) flush()
        }
    }

    private fun <T> setState(state: State<T>, value: T) {
        checkAccess()
        if (nodes[state]?.let { it.failure == null && strictEqual(it.value, value) } == true) return
        writeVersion += 1
        val node = nodes.getOrPut(state) { Node() }
        node.value = value
        node.epoch += 1
        changed.add(state)
        val dependents = node.mounted?.dependents
        if (!dependents.isNullOrEmpty()) {
            val work = mutation ?: Mutation().also { mutation = it }
            work.sources.add(state)
            markDirty(dependents, work)
        }
    }

    private fun <I, O> invoke(command: Command<I, O>, input: I): O {
        var synchronous = true
        val context =
            object : CommandContext {
                override fun <T> get(signal: Signal<T>): T = this@Store.get(signal)

                override fun <T> set(state: State<T>, value: T) = write { setState(state, value) }

                override fun <T> update(state: State<T>, updater: (T) -> T) = write {
                    setState(state, updater(get(state)))
                }

                override fun <I, O> set(command: Command<I, O>, input: I): O = write {
                    invoke(command, input)
                }

                private fun <T> write(operation: () -> T): T = publicEntry {
                    try {
                        operation()
                    } finally {
                        if (!synchronous) flush()
                    }
                }
            }
        try {
            return command.write(context, input)
        } finally {
            synchronous = false
        }
    }

    private fun markDirty(dependents: Set<Computed<*>>, work: Mutation) {
        var queue = dependents.toList()
        while (queue.isNotEmpty()) {
            val next = mutableListOf<Computed<*>>()
            for (signal in queue) {
                if (!work.dirty.add(signal)) continue
                if (!work.oldEpochs.containsKey(signal))
                    work.oldEpochs[signal] = nodes[signal]?.epoch
                nodes[signal]?.mounted?.dependents?.let(next::addAll)
            }
            queue = next
        }
    }

    private fun pull(dependents: Set<Computed<*>>, work: Mutation) {
        var queue = dependents.toList()
        val visited = mutableSetOf<Computed<*>>()
        while (queue.isNotEmpty()) {
            val next = mutableListOf<Computed<*>>()
            for (signal in queue) {
                if (!visited.add(signal)) continue
                val current = readComputed(signal)
                if (!work.oldEpochs.containsKey(signal) || work.oldEpochs[signal] == current.epoch)
                    continue
                changed.add(signal)
                current.mounted?.dependents?.let(next::addAll)
            }
            queue = next
        }
    }

    private fun flush() {
        val work = mutation
        if (work != null) {
            if (work.flushing) return
            work.flushing = true
            try {
                while (work.sources.isNotEmpty()) {
                    val sources = work.sources.toList()
                    work.sources.clear()
                    for (source in sources) nodes[source]?.mounted?.dependents?.let {
                        pull(it, work)
                    }
                }
                work.dirty.clear()
                work.oldEpochs.clear()
                if (mutation === work) mutation = null
            } finally {
                work.flushing = false
            }
        }
        val failures = mutableListOf<Throwable>()
        while (changed.isNotEmpty()) {
            val callbacks = IdentitySet<() -> Unit>()
            for (signal in changed) nodes[signal]?.mounted?.listeners?.let(callbacks::addAll)
            changed.clear()
            for (callback in callbacks) {
                try {
                    callback()
                } catch (failure: Throwable) {
                    failures.add(failure)
                }
            }
        }
        if (failures.isNotEmpty()) throw ListenerException(failures)
    }

    /** Establishes dependencies, without an initial listener notification. */
    fun watch(signal: Signal<*>, listener: () -> Unit): Subscription {
        var created: Subscription? = null
        try {
            return publicEntry {
                val mounted = mount(signal)
                mounted.listeners.add(listener)
                val subscription = Subscription {
                    if (!closed)
                        publicEntry {
                            mounted.listeners.remove(listener)
                            unmount(signal)
                            flush()
                        }
                }
                created = subscription
                flush()
                subscription
            }
        } catch (failure: Throwable) {
            try {
                created?.close()
            } catch (cleanupFailure: Throwable) {
                failure.addSuppressed(cleanupFailure)
            }
            throw failure
        }
    }

    private fun mount(signal: Signal<*>): Mounted {
        nodes[signal]?.mounted?.let {
            return it
        }
        val node = read(signal)
        val mounted = Mounted()
        node.mounted = mounted
        if (signal is Computed<*>) {
            for (dependency in node.dependencies.keys.toList()) mount(dependency)
                .dependents
                .add(signal)
        }
        return mounted
    }

    private fun unmount(signal: Signal<*>) {
        val node = nodes[signal] ?: return
        val mounted = node.mounted ?: return
        if (mounted.dependents.isNotEmpty() || mounted.listeners.isNotEmpty()) return
        if (signal is Computed<*>) {
            for (dependency in node.dependencies.keys.toList()) {
                nodes[dependency]?.mounted?.dependents?.remove(signal)
                unmount(dependency)
            }
        }
        node.mounted = null
    }

    override fun close() {
        check(Thread.currentThread() === thread) { "CCState Store closed from another thread" }
        if (closed) return
        closed = true
        val retained = nodes.values.toList()
        val evaluations = retained.mapNotNull { it.evaluation }
        for (node in retained) {
            node.mounted?.listeners?.clear()
            node.mounted?.dependents?.clear()
            node.mounted = null
            node.dependencies.clear()
            node.value = null
            node.failure = null
            node.evaluation = null
        }
        nodes.clear()
        changed.clear()
        evaluating.clear()
        mutation = null
        val failures = cancellationFailures.toMutableList()
        cancellationFailures.clear()
        for (evaluation in evaluations) {
            failures.addAll(evaluation.invalidate())
        }
        if (failures.isNotEmpty()) throw ListenerException(failures)
    }
}
