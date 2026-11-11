package ai.okou.ccstate.compose

import ai.okou.ccstate.Command
import ai.okou.ccstate.Signal
import ai.okou.ccstate.State as WritableState
import ai.okou.ccstate.Store
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SnapshotMutationPolicy
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.Deferred

private val LocalStore =
    staticCompositionLocalOf<Store> { error("CCState StoreProvider is missing") }

@Composable
fun StoreProvider(store: Store, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalStore provides store, content = content)
}

private fun <T> loadablePolicy(): SnapshotMutationPolicy<Loadable<T>> =
    object : SnapshotMutationPolicy<Loadable<T>> {
        override fun equivalent(a: Loadable<T>, b: Loadable<T>): Boolean =
            when {
                a is Loadable.Data && b is Loadable.Data -> sameObservedValue(a.value, b.value)
                a is Loadable.Error && b is Loadable.Error -> a.cause === b.cause
                else -> a === b
            }
    }

@Composable
fun <T> observeAsState(signal: Signal<T>): State<Loadable<T>> {
    val store = LocalStore.current
    val result =
        remember(store, signal) { mutableStateOf<Loadable<T>>(Loadable.Loading, loadablePolicy()) }
    DisposableEffect(store, signal) {
        val subscription = observe(store, signal) { result.value = it }
        onDispose { subscription.close() }
    }
    return result
}

@Composable
fun <T> observeDeferredAsState(
    signal: Signal<Deferred<T>>,
    keepLast: Boolean = false,
): State<Loadable<T>> {
    val store = LocalStore.current
    val scope = rememberCoroutineScope()
    val result =
        remember(store, signal) { mutableStateOf<Loadable<T>>(Loadable.Loading, loadablePolicy()) }
    DisposableEffect(store, signal, keepLast, scope) {
        val subscription = observeDeferred(store, signal, scope, keepLast) { result.value = it }
        onDispose { subscription.close() }
    }
    return result
}

@Composable
fun <T> rememberSetter(signal: WritableState<T>): (T) -> Unit {
    val store = LocalStore.current
    return remember(store, signal) { { value -> store.set(signal, value) } }
}

@Composable
fun <I, O> rememberCommand(command: Command<I, O>): (I) -> O {
    val store = LocalStore.current
    return remember(store, command) { { input -> store.set(command, input) } }
}
