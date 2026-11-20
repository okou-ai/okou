package ai.okou.android.updates

import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import android.app.Activity
import android.app.LocaleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.LocaleList
import android.provider.Settings
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

class UpdateRootApplication : TestOkouApplication() {
    internal val fixture =
        ControlledUpdates().apply {
            response = AndroidUpdates(null, updateRelease("99.0.0"))
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
    fun closingDetailsKeepsTheTransferRunningAndRequiredGateUsesTheSameProgress() {
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        compose.onNodeWithText("View update").performClick()
        compose.onNodeWithText("A useful update").assertExists()
        compose.onNodeWithText("Update").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) { app.fixture.progress != null }
        app.fixture.progress!!(617)
        compose.onNodeWithText("Updating · 50%").assertExists()
        compose.onNodeWithText("Close").performSemanticsAction(SemanticsActions.OnClick)
        assertTrue(app.updates.state.value.transfer is UpdateTransfer.Downloading)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.required }
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Updating · 50%").assertExists()
        compose.onNodeWithText("Welcome to Okou").assertDoesNotExist()
        compose.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Updating · 50%").assertExists()
        compose.onNodeWithText("Sign out").assertDoesNotExist()
    }

    @Test
    fun requiredDiscoveryKeepsTheAppliedLocaleWhileTheSessionIsRestoring() {
        compose.waitUntil(10_000) { app.updates.state.value.check == UpdateCheck.Checking }
        val locales = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val original = locales.applicationLocales
        val applied = LocaleList.forLanguageTags("zh-Hans")
        val gate = checkNotNull(app.fixture.heldCheck)
        try {
            compose.activityRule.scenario.onActivity { locales.applicationLocales = applied }
            compose.activityRule.scenario.recreate()
            compose
                .onNodeWithText(compose.activity.getString(R.string.auth_restoring))
                .assertExists()
            app.fixture.response = AndroidUpdates("99.0.0", updateRelease("99.0.0"))
            gate.complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.required }
            compose
                .onNodeWithText(compose.activity.getString(R.string.updates_required))
                .assertIsDisplayed()
            assertEquals(applied, locales.applicationLocales)
        } finally {
            gate.complete(Unit)
            compose.activityRule.scenario.onActivity { locales.applicationLocales = original }
        }
    }

    @Test
    fun authorizationDenialAndInstallerCancellationKeepThePackageForExplicitContinuation() {
        app.fixture.heldCheck!!.complete(Unit)
        val packageManager = shadowOf(app.packageManager)
        packageManager.setCanRequestPackageInstalls(false)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
        compose.onNodeWithText("Update").assertIsDisplayed().performClick()
        finishDownload()
        compose.onNodeWithText("Allow update installation").assertIsDisplayed()
        compose.onNodeWithText("Open Settings").performClick()
        val denied = nextLaunch()
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, denied.intent.action)
        assertEquals("package:${app.packageName}", denied.intent.dataString)
        returnFrom(denied.requestCode)
        compose.onNodeWithText("Continue installation").assertIsDisplayed()
        assertNoPlatformLaunch()

        compose.onNodeWithText("Continue installation").performClick()
        compose.onNodeWithText("Open Settings").performClick()
        val granted = nextLaunch()
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, granted.intent.action)
        compose.activityRule.scenario.recreate()
        packageManager.setCanRequestPackageInstalls(true)
        returnFrom(granted.requestCode)
        val install = nextLaunch()
        val intent = install.intent
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals("${app.packageName}.updates", intent.data!!.authority)
        assertEquals("content", intent.data!!.scheme)
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
        returnFrom(install.requestCode)
        compose.onNodeWithText("Continue installation").assertIsDisplayed()
        assertNoPlatformLaunch()
        assertTrue(app.updates.state.value.required)
        assertTrue(app.updates.state.value.transfer is UpdateTransfer.Ready)
        assertEquals(1, app.fixture.downloadedReleases.size)
    }

    @Test
    fun backgroundCompletionHandsOffOnlyAfterResuming() {
        allowInstallAndDiscoverUpdate()
        compose.onNodeWithText("View update").performClick()
        compose.onNodeWithText("Update").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Close").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        compose.activityRule.scenario.onActivity { it.onWindowFocusChanged(false) }
        finishDownload()
        compose.activityRule.scenario.onActivity {
            assertNull(shadowOf(it).peekNextStartedActivityForResult())
        }
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        // ActivityScenario changes the lifecycle separately from window focus.
        compose.activityRule.scenario.onActivity { it.onWindowFocusChanged(true) }
        assertEquals(Intent.ACTION_VIEW, nextLaunch().intent.action)
        assertNoPlatformLaunch()
    }

    private fun allowInstallAndDiscoverUpdate() {
        shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
    }

    private fun finishDownload() {
        // The sandbox uses a new private files directory for each test in the same classloader.
        val provider =
            checkNotNull(
                app.packageManager.resolveContentProvider(
                    "${app.packageName}.updates",
                    PackageManager.GET_META_DATA,
                )
            )
        FileProvider().attachInfo(app, provider)
        val file = File(app.filesDir, "updates/install.apk")
        file.parentFile!!.mkdirs()
        file.writeText("verified external-service fixture")
        app.fixture.transfer.complete(file)
        compose.waitUntil(10_000) { app.updates.state.value.canInstall }
    }

    private fun nextLaunch(): org.robolectric.shadows.ShadowActivity.IntentForResult {
        val shadow = shadowOf(compose.activity)
        compose.waitUntil(10_000) { shadow.peekNextStartedActivityForResult() != null }
        return checkNotNull(shadow.nextStartedActivityForResult)
    }

    private fun returnFrom(requestCode: Int) {
        compose.activityRule.scenario.onActivity {
            assertTrue(
                it.activityResultRegistry.dispatchResult(
                    requestCode,
                    Activity.RESULT_CANCELED,
                    null,
                )
            )
        }
    }

    private fun assertNoPlatformLaunch() {
        compose.runOnIdle {
            assertNull(shadowOf(compose.activity).peekNextStartedActivityForResult())
        }
    }
}
