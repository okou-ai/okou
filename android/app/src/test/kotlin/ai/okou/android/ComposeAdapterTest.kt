package ai.okou.android

import ai.okou.ccstate.Store
import ai.okou.ccstate.compose.Loadable
import ai.okou.ccstate.compose.StoreProvider
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
