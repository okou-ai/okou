package ai.okou.ccstate.compose

import ai.okou.ccstate.Store
import ai.okou.ccstate.command
import ai.okou.ccstate.state
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ComposeAdapterTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun replacingSignalAndCommandArgumentsRebindsStableActions() {
        val store = compose.runOnIdle { Store() }
        val first = state(0)
        val second = state(10)
        val firstAction = command<Unit, Unit> { context, _ -> context.update(first) { it + 1 } }
        val secondAction = command<Unit, Unit> { context, _ -> context.update(second) { it + 1 } }
        val selected = mutableStateOf(false)
        var setter: ((Int) -> Unit)? = null
        var action: ((Unit) -> Unit)? = null
        try {
            compose.setContent {
                StoreProvider(store) {
                    val signal = if (selected.value) second else first
                    val result by observeAsState(signal)
                    val set = rememberSetter(signal)
                    val invoke = rememberCommand(if (selected.value) secondAction else firstAction)
                    SideEffect {
                        setter = set
                        action = invoke
                    }
                    Column {
                        BasicText(
                            when (val value = result) {
                                is Loadable.Data -> "Value " + value.value
                                is Loadable.Error -> "failed"
                                Loadable.Loading -> "pending"
                            }
                        )
                        BasicText("Set", Modifier.clickable { set(7) })
                        BasicText("Invoke", Modifier.clickable { invoke(Unit) })
                        BasicText("Switch", Modifier.clickable { selected.value = true })
                    }
                }
            }
            compose.onNodeWithText("Value 0").assertExists()
            val previous = compose.runOnIdle { checkNotNull(setter) to checkNotNull(action) }
            compose.onNodeWithText("Set").performClick()
            compose.onNodeWithText("Value 7").assertExists()
            compose.runOnIdle {
                assertSame(previous.first, setter)
                assertSame(previous.second, action)
            }
            compose.onNodeWithText("Switch").performClick()
            compose.onNodeWithText("Value 10").assertExists()
            compose.onNodeWithText("Invoke").performClick()
            compose.onNodeWithText("Value 11").assertExists()
            compose.onNodeWithText("Set").performClick()
            compose.onNodeWithText("Value 7").assertExists()
            compose.runOnIdle {
                assertEquals(7, store.get(first))
                assertEquals(7, store.get(second))
            }
        } finally {
            compose.runOnIdle { store.close() }
        }
    }

    @Test
    fun disposingTheCompositionDetachesItsStateWithoutCancellingSharedWork() {
        val store = compose.runOnIdle { Store() }
        val task = CompletableDeferred<String>()
        val signal = state<Deferred<String>>(task)
        val synchronous = state(0)
        val attached = mutableStateOf(true)
        var retained: State<Loadable<String>>? = null
        var retainedSynchronous: State<Loadable<Int>>? = null
        try {
            compose.setContent {
                StoreProvider(store) {
                    Column {
                        if (attached.value) {
                            val result = observeDeferredAsState(signal)
                            val current = observeAsState(synchronous)
                            SideEffect {
                                retained = result
                                retainedSynchronous = current
                            }
                            BasicText("Attached")
                        } else BasicText("Detached")
                        BasicText("Hide", Modifier.clickable { attached.value = false })
                    }
                }
            }
            compose.onNodeWithText("Attached").assertExists()
            compose.onNodeWithText("Hide").performClick()
            compose.onNodeWithText("Detached").assertExists()
            compose.runOnIdle {
                assertTrue(task.isActive)
                task.complete("late")
                store.set(signal, CompletableDeferred("replacement"))
                store.set(synchronous, 1)
            }
            compose.runOnIdle {
                assertSame(Loadable.Loading, checkNotNull(retained).value)
                assertEquals(0, (checkNotNull(retainedSynchronous).value as Loadable.Data).value)
                assertEquals(1, store.get(synchronous))
            }
            compose.onNodeWithText("Detached").assertExists()
        } finally {
            compose.runOnIdle { store.close() }
        }
    }

    @Test
    fun retainedNaNResultsDoNotCommitAnUnchangedSnapshot() {
        val store = compose.runOnIdle { Store() }
        val signal = state<Deferred<Double>>(CompletableDeferred(Double.NaN))
        var commits = 0
        try {
            compose.setContent {
                StoreProvider(store) {
                    val result by observeDeferredAsState(signal, keepLast = true)
                    SideEffect { commits++ }
                    BasicText(
                        when (val value = result) {
                            is Loadable.Data -> value.value.toString()
                            is Loadable.Error -> "failed"
                            Loadable.Loading -> "pending"
                        }
                    )
                }
            }
            compose.onNodeWithText("NaN").assertExists()
            val initial = compose.runOnIdle { commits }
            compose.runOnIdle { store.set(signal, CompletableDeferred(Double.NaN)) }
            compose.runOnIdle { assertEquals(initial, commits) }
        } finally {
            compose.runOnIdle { store.close() }
        }
    }

    @Test
    fun equalLookingNewReferencesRemainObservableInCompose() {
        val store = compose.runOnIdle { Store() }
        val first = listOf("draft")
        val replacement = mutableListOf("draft")
        assertEquals(first, replacement)
        val signal = state<List<String>>(first)
        try {
            compose.setContent {
                StoreProvider(store) {
                    val result by observeAsState(signal)
                    BasicText(
                        when (val value = result) {
                            is Loadable.Data ->
                                if (value.value === first) "Original reference"
                                else "Replacement reference"
                            is Loadable.Error -> "failed"
                            Loadable.Loading -> "pending"
                        }
                    )
                }
            }
            compose.onNodeWithText("Original reference").assertExists()
            compose.runOnIdle { store.set(signal, replacement) }
            compose.onNodeWithText("Replacement reference").assertExists()
        } finally {
            compose.runOnIdle { store.close() }
        }
    }

    @Test
    fun retainedDeferredValuesPreserveNativePrecisionAndSignedZero() {
        val store = compose.runOnIdle { Store() }
        val signal = state<Deferred<Number>>(CompletableDeferred(9_007_199_254_740_992L))
        try {
            compose.setContent {
                StoreProvider(store) {
                    val result by observeDeferredAsState(signal, keepLast = true)
                    BasicText(
                        when (val value = result) {
                            is Loadable.Data -> value.value.toString()
                            is Loadable.Error -> "failed"
                            Loadable.Loading -> "pending"
                        }
                    )
                }
            }
            compose.onNodeWithText("9007199254740992").assertExists()
            compose.runOnIdle { store.set(signal, CompletableDeferred(9_007_199_254_740_993L)) }
            compose.onNodeWithText("9007199254740993").assertExists()
            compose.runOnIdle { store.set(signal, CompletableDeferred(0.0)) }
            compose.onNodeWithText("0.0").assertExists()
            compose.runOnIdle { store.set(signal, CompletableDeferred(-0.0)) }
            compose.onNodeWithText("-0.0").assertExists()
        } finally {
            compose.runOnIdle { store.close() }
        }
    }

    @Test
    fun replacingTheProviderDoesNotPublishTheOldDeferredOrCancelItsProducer() {
        val first = compose.runOnIdle { Store() }
        val second = compose.runOnIdle { Store() }
        val old = CompletableDeferred<String>()
        val current = CompletableDeferred<String>()
        val signal = state<Deferred<String>>(old)
        val selected = mutableStateOf(false)
        compose.runOnIdle { second.set(signal, current) }
        try {
            compose.setContent {
                Column {
                    StoreProvider(if (selected.value) second else first) {
                        val result by observeDeferredAsState(signal)
                        BasicText(
                            when (val value = result) {
                                is Loadable.Data -> value.value
                                is Loadable.Error -> "failed"
                                Loadable.Loading -> "pending"
                            }
                        )
                        BasicText("Switch owner", Modifier.clickable { selected.value = true })
                    }
                }
            }
            compose.onNodeWithText("pending").assertExists()
            compose.onNodeWithText("Switch owner").performClick()
            compose.runOnIdle { current.complete("Current result") }
            compose.onNodeWithText("Current result").assertExists()
            compose.runOnIdle {
                assertFalse(old.isCancelled)
                old.complete("Obsolete result")
            }
            compose.onNodeWithText("Current result").assertExists()
        } finally {
            compose.runOnIdle {
                first.close()
                second.close()
            }
        }
    }
}
