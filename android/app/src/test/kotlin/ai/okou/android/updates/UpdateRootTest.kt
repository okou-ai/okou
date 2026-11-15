package ai.okou.android.updates

import ai.okou.android.MainActivity
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class UpdateRootApplication : TestOkouApplication() {
    internal val fixture =
        ControlledUpdates().apply {
            response = ai.okou.android.api.generated.AndroidUpdates(null, updateRelease("99.0.0"))
            heldCheck = CompletableDeferred()
        }

    init {
        updateService = fixture
    }

    override fun createAuthentication(): Authentication = TestAuthentication(AuthenticationState())
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = UpdateRootApplication::class)
class UpdateRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as UpdateRootApplication

    @Test
    fun heldDiscoveryDoesNotBlockNativeRootAndLaterSurvivesRecreation() {
        compose.onNodeWithText("Welcome to Okou").assertExists()
        assertFalse(app.updates.state.value.required)
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        compose.onNodeWithText("Update 99.0.0 is available").assertExists()
        compose.onNodeWithText("Later").performClick()
        compose.waitUntil(10_000) { !app.updates.state.value.announce }
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Welcome to Okou").assertExists()
        compose.onNodeWithText("View update").assertDoesNotExist()
    }

    @Test
    fun detailsShareDownloadCancellationAndRequiredGateSurvivesRecreation() {
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        compose.onNodeWithText("View update").performClick()
        compose.onNodeWithText("A useful update").assertExists()
        compose.onNodeWithText("Download update").performClick()
        compose.waitUntil(10_000) { app.fixture.progress != null }
        app.fixture.progress!!(617)
        compose.onNodeWithText("Downloading… 50%").assertExists()
        compose.onNodeWithText("Cancel download").performClick()
        compose.onNode(hasText("Later") and hasAnyAncestor(isDialog())).performClick()
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.required }
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Welcome to Okou").assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Download update").assertIsDisplayed()
        compose.onNodeWithText("Sign out").assertDoesNotExist()
    }

    @Test
    fun installationUsesNarrowUriGrantsAndDoesNotClearRequiredState() {
        app.fixture.heldCheck!!.complete(Unit)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.suitable }
        val file = java.io.File(app.filesDir, "updates/install.apk")
        file.parentFile!!.mkdirs()
        file.writeText("verified external-service fixture")
        app.fixture.transfer.complete(file)
        compose.onNodeWithText("Download update").assertIsDisplayed().performClick()
        compose.waitUntil(10_000) { app.updates.state.value.transfer == UpdateTransfer.Ready }
        val packageManager = org.robolectric.Shadows.shadowOf(app.packageManager)
        packageManager.setCanRequestPackageInstalls(false)
        compose.onNodeWithText("Allow update installation").assertIsDisplayed().performClick()
        compose.waitUntil(10_000) {
            org.robolectric.Shadows.shadowOf(compose.activity).peekNextStartedActivity() != null
        }
        assertEquals(
            android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            org.robolectric.Shadows.shadowOf(compose.activity).nextStartedActivity.action,
        )
        packageManager.setCanRequestPackageInstalls(true)
        compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        compose.activityRule.scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        compose.onNodeWithText("Install update").assertIsDisplayed().performClick()
        compose.waitUntil(10_000) {
            org.robolectric.Shadows.shadowOf(compose.activity).peekNextStartedActivity() != null
        }
        val intent = org.robolectric.Shadows.shadowOf(compose.activity).nextStartedActivity
        assertEquals(android.content.Intent.ACTION_VIEW, intent.action)
        assertEquals("${app.packageName}.updates", intent.data!!.authority)
        assertEquals("content", intent.data!!.scheme)
        assertTrue(intent.flags and android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
        assertTrue(app.updates.state.value.required)
        assertEquals(UpdateTransfer.Ready, app.updates.state.value.transfer)
    }
}
