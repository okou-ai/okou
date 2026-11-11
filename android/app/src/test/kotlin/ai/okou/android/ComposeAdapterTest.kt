package ai.okou.android

import ai.okou.ccstate.Store
import ai.okou.ccstate.compose.Loadable
import ai.okou.ccstate.compose.StoreProvider
import ai.okou.ccstate.compose.observeAsState
import ai.okou.ccstate.compose.observeDeferredAsState
import ai.okou.ccstate.state
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
                    Text(
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
                    Text(
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
                OkouTheme {
                    StoreProvider(if (selected.value) second else first) {
                        val result by observeDeferredAsState(signal)
                        Text(
                            when (val value = result) {
                                is Loadable.Data -> value.value
                                is Loadable.Error -> "failed"
                                Loadable.Loading -> "pending"
                            }
                        )
                        Button(onClick = { selected.value = true }) { Text("Switch owner") }
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
