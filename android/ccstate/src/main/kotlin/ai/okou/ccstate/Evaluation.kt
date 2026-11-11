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

    internal fun invalidate(): List<Throwable> {
        current = false
        return cancellation?.abort() ?: emptyList()
    }
}

class EvaluationSignal internal constructor() {
    var aborted: Boolean = false
        private set

    private val callbacks = IdentitySet<() -> Unit>()

    fun throwIfAborted() {
        if (aborted) throw CancellationException("CCState evaluation was invalidated")
    }

    /**
     * Runs immediately if already invalidated; otherwise registers cleanup. Closing the returned
     * handle before this callback's dispatch turn prevents its invocation.
     */
    fun onCancel(callback: () -> Unit): Subscription {
        if (aborted) {
            callback()
            return Subscription(null)
        }
        callbacks.add(callback)
        return Subscription { callbacks.remove(callback) }
    }

    internal fun abort(): List<Throwable> {
        if (aborted) return emptyList()
        aborted = true
        val pending = callbacks.toList()
        val failures = mutableListOf<Throwable>()
        for (callback in pending) {
            if (!callbacks.remove(callback)) continue
            try {
                callback()
            } catch (failure: Throwable) {
                failures.add(failure)
            }
        }
        return failures
    }
}
