package ai.okou.ccstate.compose

import ai.okou.ccstate.Signal
import ai.okou.ccstate.Store
import ai.okou.ccstate.Subscription
import ai.okou.ccstate.subscription
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>

    class Data<T>(val value: T) : Loadable<T>

    class Error(val cause: Throwable) : Loadable<Nothing>
}

/** Direct observer entry point, also usable by non-Compose native adapters. */
fun <T> observe(store: Store, signal: Signal<T>, onChange: (Loadable<T>) -> Unit): Subscription {
    fun refresh() {
        val next =
            try {
                Loadable.Data(store.get(signal))
            } catch (failure: Throwable) {
                Loadable.Error(failure)
            }
        onChange(next)
    }
    val subscription = store.watch(signal, ::refresh)
    try {
        refresh()
    } catch (failure: Throwable) {
        subscription.close()
        throw failure
    }
    return subscription
}

/**
 * Resolves a graph's shared Deferred. Closing cancels only this observer's waiter. The supplied
 * scope and all graph interactions must run on the Store's owner thread.
 */
@OptIn(ExperimentalCoroutinesApi::class)
fun <T> observeDeferred(
    store: Store,
    signal: Signal<Deferred<T>>,
    scope: CoroutineScope,
    keepLast: Boolean = false,
    onChange: (Loadable<T>) -> Unit,
): Subscription {
    scope.coroutineContext.ensureActive()
    var active = true
    var generation = 0L
    var waiter: Job? = null
    val subscription =
        observe(store, signal) { result ->
            val version = ++generation
            waiter?.cancel()
            waiter = null
            when (result) {
                is Loadable.Error -> onChange(result)
                is Loadable.Data -> {
                    if (!keepLast) onChange(Loadable.Loading)
                    val nextWaiter =
                        scope.launch(start = CoroutineStart.UNDISPATCHED) {
                            val next =
                                try {
                                    Loadable.Data(result.value.await())
                                } catch (failure: CancellationException) {
                                    if (!currentCoroutineContext().isActive) throw failure
                                    // await may recover/copy stack traces. The producer's
                                    // completion cause preserves the original error identity.
                                    Loadable.Error(
                                        checkNotNull(result.value.getCompletionExceptionOrNull()) {
                                            "Deferred await failed without a producer failure"
                                        }
                                    )
                                } catch (failure: Throwable) {
                                    Loadable.Error(
                                        checkNotNull(result.value.getCompletionExceptionOrNull()) {
                                            "Deferred await failed without a producer failure"
                                        }
                                    )
                                }
                            if (
                                active &&
                                    version == generation &&
                                    currentCoroutineContext().isActive
                            )
                                onChange(next)
                        }
                    // A completed Deferred can invoke the callback before launch returns;
                    // a reentrant graph write may already have installed the next waiter.
                    if (active && version == generation) waiter = nextWaiter
                    else nextWaiter.cancel()
                }
                Loadable.Loading -> Unit
            }
        }
    return subscription {
        active = false
        generation += 1
        waiter?.cancel()
        waiter = null
        subscription.close()
    }
}

/** React's adapter defaults to Object.is rather than the core's === comparison. */
internal fun sameObservedValue(first: Any?, second: Any?): Boolean =
    when {
        first is Double && second is Double -> first.toBits() == second.toBits()
        first is Float && second is Float -> first.toBits() == second.toBits()
        first is Long && second is Long -> first == second
        first is Int && second is Int -> first == second
        first is Short && second is Short -> first == second
        first is Byte && second is Byte -> first == second
        first is String && second is String -> first == second
        first is Boolean && second is Boolean -> first == second
        first is Char && second is Char -> first == second
        else -> first === second
    }
