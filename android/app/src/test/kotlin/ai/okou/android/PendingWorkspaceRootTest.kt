package ai.okou.android

import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.auth.WorkspaceBootstrap
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import kotlinx.coroutines.CompletableDeferred
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Hold the external workspace/preferences response while the real root owns initialization. */
class PendingWorkspaceApplication : TestOkouApplication() {
    val preferencesResponse = CompletableDeferred<Unit>()

    override fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession {
        val service = super.createWorkspaceSession(identity, tokens)
        return object : WorkspaceSession by service {
            override suspend fun bootstrap(): WorkspaceBootstrap {
                preferencesResponse.await()
                return service.bootstrap()
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = PendingWorkspaceApplication::class)
class PendingWorkspaceRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @After
    fun releaseResponse() {
        compose.runOnIdle {
            (compose.activity.application as PendingWorkspaceApplication)
                .preferencesResponse
                .complete(Unit)
        }
    }

    @Test
    fun pendingPreferencesKeepTheNativeRootVisibleAcrossRecreation() {
        compose.onNodeWithText("Preparing your workspace…").assertExists()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Preparing your workspace…").assertExists()
        compose.onNode(hasSetTextAction()).assertDoesNotExist()
        releaseResponse()
        compose.onNode(hasSetTextAction()).assertExists()
        compose.onNodeWithText("Settings").assertExists()
    }
}
