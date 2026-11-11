package ai.okou.ccstate

import java.util.concurrent.CancellationException

/** Invalidation belongs to one evaluation, not to an observer or arbitrary returned task. */
class Evaluation internal constructor() {
    private var current = true
    private var cancellation: EvaluationSignal? = null

    val signal: EvaluationSignal
        get() =
            cancellation
                ?: EvaluationSignal().also {
                    cancellation = it
                    if (!current) it.abort()
                }

    internal fun invalidate() {
        current = false
        cancellation?.abort()
    }
}

class EvaluationSignal internal constructor() {
    var aborted: Boolean = false
        private set

    private val callbacks = IdentitySet<() -> Unit>()

    fun throwIfAborted() {
        if (aborted) throw CancellationException("CCState evaluation was invalidated")
    }

    fun onCancel(callback: () -> Unit): Subscription {
        if (aborted) {
            callback()
            return Subscription(null)
        }
        callbacks.add(callback)
        return Subscription { callbacks.remove(callback) }
    }

    internal fun abort() {
        if (aborted) return
        aborted = true
        val pending = callbacks.toList()
        callbacks.clear()
        val failures = mutableListOf<Throwable>()
        for (callback in pending) {
            try {
                callback()
            } catch (failure: Throwable) {
                failures.add(failure)
            }
        }
        if (failures.isNotEmpty()) throw ListenerException(failures)
    }
}
