package ai.okou.android

import ai.okou.android.state.SavedStateBudgetExceeded
import ai.okou.android.state.SavedStatePolicy
import android.os.Bundle
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 35], qualifiers = "en-rUS", application = TestOkouApplication::class)
class SavedStateBudgetTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun ordinaryNativeStateRemainsRestorable() {
        compose.onNodeWithText("Chats").assertExists()
        compose.runOnIdle {
            compose.activity.savedStateRegistry.registerSavedStateProvider("restoration-probe") {
                Bundle().apply { putInt("position", 17) }
            }
        }
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Chats").assertExists()
        compose.runOnIdle {
            assertEquals(
                17,
                compose.activity.savedStateRegistry
                    .consumeRestoredStateForKey("restoration-probe")
                    ?.getInt("position"),
            )
        }
    }

    @Test
    fun oversizedJetpackProviderIsCheckedAfterTheSuperclassCompletes() {
        compose.onNodeWithText("Chats").assertExists()
        compose.runOnIdle {
            compose.activity.savedStateRegistry.registerSavedStateProvider("oversized-probe") {
                Bundle().apply { putString("document", "synthetic input".repeat(5_000)) }
            }
            try {
                val exceeded =
                    assertThrows(SavedStateBudgetExceeded::class.java) {
                        InstrumentationRegistry.getInstrumentation()
                            .callActivityOnSaveInstanceState(compose.activity, Bundle())
                    }
                assertTrue(exceeded.bytes >= SavedStatePolicy.ACTIVITY_BYTES)
            } finally {
                compose.activity.savedStateRegistry.unregisterSavedStateProvider("oversized-probe")
            }
        }
    }
}
