package ai.okou.android.updates

import ai.okou.android.BuildConfig
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.AuthenticationState
import ai.okou.android.testAuthenticationState
import android.app.Activity
import android.app.LocaleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.LocaleList
import android.provider.Settings
import android.text.format.Formatter
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

class UpdateRootApplication : TestOkouApplication() {
    internal val fixture =
        ControlledUpdates().apply {
            response = AndroidUpdates(null, updateRelease("99.0.0"))
            heldCheck = CompletableDeferred()
        }

    internal val online = MutableStateFlow(true)

    override val updates by lazy {
        AppUpdates(
            fixture,
            MemoryUpdateStore(),
            BuildConfig.VERSION_NAME,
            Build.VERSION.SDK_INT,
            connectivity = online,
        )
    }

    override fun createAuthentication(): Authentication = TestAuthentication(AuthenticationState())
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = UpdateRootApplication::class)
class UpdateRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as UpdateRootApplication

    @After
    fun closeUpdateOwner() {
        app.updates.close()
    }

    @Test
    fun optionalDiscoveryLeavesTheRestoringRootInPlaceAcrossRecreation() {
        val restoring = compose.onNodeWithText(app.getString(R.string.app_name))
        val startupBounds = restoring.assertIsDisplayed().getUnclippedBoundsInRoot()
        assertFalse(app.updates.state.value.required)
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        assertEquals(startupBounds, restoring.getUnclippedBoundsInRoot())
        compose.activityRule.scenario.recreate()
        assertEquals(startupBounds, restoring.assertIsDisplayed().getUnclippedBoundsInRoot())
        assertTrue(app.updates.state.value.available)
    }

    @Test
    @Config(qualifiers = "en-rUS-w340dp-h700dp")
    fun settingsUpdateStatusStaysInlineAboveTheGroupWidthThreshold() {
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        openUpdateSettings()
        updateSettingsRow().performScrollTo()
        val title =
            compose
                .onNodeWithText(app.getString(R.string.updates_title), useUnmergedTree = true)
                .assertIsDisplayed()
                .getUnclippedBoundsInRoot()
        val status =
            compose
                .onNodeWithText(app.getString(R.string.updates_needed), useUnmergedTree = true)
                .assertIsDisplayed()
                .getUnclippedBoundsInRoot()
        assertEquals(
            ((title.top + title.bottom) / 2).value,
            ((status.top + status.bottom) / 2).value,
            1f,
        )
    }

    @Test
    fun closingDetailsKeepsTheTransferRunningAndRequiredGateUsesTheSameProgress() {
        app.fixture.heldCheck!!.complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.available }
        openUpdateSettings()
        updateSettingsRow().performScrollTo().performClick()
        compose.onNodeWithText(app.getString(R.string.updates_version, "99.0.0")).assertExists()
        compose.onNodeWithText("Download update").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) { app.fixture.progress != null }
        app.fixture.progress!!(617)
        updateDetailText("Downloading · 50%").assertExists()
        compose.onNodeWithText("Close").performSemanticsAction(SemanticsActions.OnClick)
        assertTrue(app.updates.state.value.transfer is UpdateTransfer.Downloading)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.required }
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Downloading · 50%").assertExists()
        compose.onNodeWithText(app.getString(R.string.updates_unavailable)).assertDoesNotExist()
        compose.onNodeWithText("Settings").assertDoesNotExist()
        compose.activityRule.scenario.recreate()
        compose.onNodeWithText("Update Okou to continue").assertExists()
        compose.onNodeWithText("Downloading · 50%").assertExists()
        compose.onNodeWithText("Sign out").assertDoesNotExist()
    }

    @Test
    fun detailsKeepKeyboardFocusThroughProgressAndLeaveItOnCloseAfterMoving() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            val release = updateRelease("99.0.0")
            app.fixture.response = AndroidUpdates(null, release.copy(minimumSdk = 36))
            checkNotNull(app.fixture.heldCheck).complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.available }
            openUpdateSettings()
            updateSettingsRow().performScrollTo().performClick()

            val recheck = CompletableDeferred<Unit>()
            compose.runOnIdle {
                app.fixture.heldCheck = recheck
                app.fixture.response = AndroidUpdates(null, release)
            }
            compose
                .onNodeWithText("Check versions")
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .assertIsFocused()
                .performKeyInput { pressKey(Key.Enter) }
            updateDetailText("Checking…").assertIsFocused().assertHasNoClickAction()
            recheck.complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }

            val download = updateDetailText("Download update")
            download.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
            updateDetailText("Preparing…")
                .assertIsFocused()
                .assertHasNoClickAction()
                .performKeyInput { pressKey(Key.DirectionLeft) }
            val close = updateDetailText("Close")
            close.assertIsFocused()
            app.fixture.transfer.completeExceptionally(IOException("download failed"))
            compose.waitUntil(10_000) { app.updates.state.value.transfer is UpdateTransfer.Failed }
            updateDetailText("Retry download").assertIsEnabled()
            close.assertIsFocused()
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w240dp-h450dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun detailsKeepTheSameActionBoundsWithLargeTextThroughDownloadAndReady() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            shadowOf(app.packageManager).setCanRequestPackageInstalls(false)
            app.fixture.heldCheck!!.complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }
            openUpdateSettings()
            val openDetails = updateSettingsRow()
            openDetails.performScrollTo().performClick()
            val title = updateDetailsHeading()
            val update = compose.onNodeWithText("Download update")
            val titleBounds = title.assertIsDisplayed().getUnclippedBoundsInRoot()
            val actionBounds = update.assertIsDisplayed().getUnclippedBoundsInRoot()
            update.performSemanticsAction(SemanticsActions.OnClick)
            compose.waitUntil(10_000) { app.fixture.progress != null }
            app.fixture.progress!!(617)
            val progress =
                compose.onNode(
                    SemanticsMatcher.expectValue(
                        SemanticsProperties.ProgressBarRangeInfo,
                        ProgressBarRangeInfo(0.5f, 0f..1f),
                    ),
                )
            assertEquals(actionBounds, progress.assertIsDisplayed().getUnclippedBoundsInRoot())
            assertEquals(titleBounds, title.getUnclippedBoundsInRoot())

            compose.onNodeWithText("Close").performSemanticsAction(SemanticsActions.OnClick)
            finishDownload()
            compose.onNodeWithText("Allow update installation").assertIsDisplayed()
            compose.onNodeWithText("Later").performClick()
            assertNoPlatformLaunch()
            openDetails.performScrollTo().performClick()
            val ready = updateDetailText("Continue installation")
            assertEquals(actionBounds, ready.assertIsDisplayed().getUnclippedBoundsInRoot())
            assertEquals(titleBounds, title.getUnclippedBoundsInRoot())
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w360dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortUpdateDetailsRevealNewFailureWithoutMovingTheActions() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(1.5f)
            compose.activityRule.scenario.recreate()
            app.fixture.response =
                AndroidUpdates(null, updateRelease("99.0.0").copy(minimumSdk = 36))
            checkNotNull(app.fixture.heldCheck).complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.available }
            openUpdateSettings()
            updateSettingsRow().performScrollTo().performClick()
            val heading = updateDetailsHeading()
            val close = updateDetailText("Close")
            val headingBounds = heading.assertIsDisplayed().getUnclippedBoundsInRoot()
            val closeBounds = close.assertIsDisplayed().getUnclippedBoundsInRoot()
            compose.runOnIdle { app.fixture.failCheck = true }
            updateDetailText("Check versions").performClick()
            val error =
                compose
                    .onNodeWithText(app.getString(R.string.updates_error_check))
                    .assertIsDisplayed()
            updateDetailText("Retry check").assertIsEnabled()
            assertTrue(error.getUnclippedBoundsInRoot().bottom <= closeBounds.top)
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            assertEquals(closeBounds, close.getUnclippedBoundsInRoot())
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w340dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortUpdateDetailsRevealTheDiscoveredVersionWithoutMovingTheActions() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(1.5f)
            compose.activityRule.scenario.recreate()
            val release = updateRelease("99.1234.5678").copy(size = 123_456_789)
            compose.runOnIdle { app.fixture.response = AndroidUpdates(null, release) }
            openUpdateSettings(viaOverflow = false)
            updateSettingsRow().performScrollTo().performClick()
            val heading = updateDetailsHeading()
            val close = updateDetailText("Close")
            val installed =
                updateDetailText(
                    app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME),
                )
            val headingBounds = heading.assertIsDisplayed().getUnclippedBoundsInRoot()
            val closeBounds = close.assertIsDisplayed().getUnclippedBoundsInRoot()
            val installedTop = installed.assertIsDisplayed().getUnclippedBoundsInRoot().top
            val actionBounds =
                updateDetailText("Checking…").assertIsDisplayed().getUnclippedBoundsInRoot()

            checkNotNull(app.fixture.heldCheck).complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }
            val version = updateDetailText(app.getString(R.string.updates_version, release.version))
            val size =
                compose.onNodeWithContentDescription(
                    app.getString(
                        R.string.updates_package_size,
                        Formatter.formatShortFileSize(app, release.size),
                    ),
                )
            val versionBounds = version.assertIsDisplayed().getUnclippedBoundsInRoot()
            val sizeBounds = size.assertIsDisplayed().getUnclippedBoundsInRoot()
            val resultTop = minOf(versionBounds.top, sizeBounds.top)
            val resultBottom = maxOf(versionBounds.bottom, sizeBounds.bottom)
            val bodyTop = headingBounds.bottom + 4.dp
            val bodyBottom = closeBounds.top - 8.dp
            val installedAfter = installed.getUnclippedBoundsInRoot().top
            assertTrue(
                "Expected the results to scroll. Installed version moved from $installedTop to " +
                    "$installedAfter, result spans $resultTop–$resultBottom, " +
                    "body spans $bodyTop–$bodyBottom.",
                installedAfter < installedTop,
            )
            if (resultBottom - resultTop <= bodyBottom - bodyTop) {
                assertTrue(
                    "Result $resultTop–$resultBottom fits in the body $bodyTop–$bodyBottom.",
                    resultTop >= bodyTop && resultBottom <= bodyBottom,
                )
            }
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            assertEquals(closeBounds, close.getUnclippedBoundsInRoot())
            assertEquals(
                actionBounds,
                updateDetailText("Download update").getUnclippedBoundsInRoot(),
            )
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "w240dp-h200dp")
    fun requiredUpdateActionIsReachableInACompactWindow() {
        app.fixture.heldCheck!!.complete(Unit)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
        val update = compose.onNodeWithText("Download update")
        compose.onNodeWithText("Update required").assertIsDisplayed()
        val bounds = update.assertIsDisplayed().getUnclippedBoundsInRoot()
        update.performClick()
        compose.waitUntil(10_000) { app.updates.state.value.transfer is UpdateTransfer.Downloading }
        val progress =
            compose.onNode(
                SemanticsMatcher.expectValue(
                    SemanticsProperties.ProgressBarRangeInfo,
                    ProgressBarRangeInfo.Indeterminate,
                ),
            )
        assertEquals(bounds, progress.assertIsDisplayed().getUnclippedBoundsInRoot())
        compose.onNodeWithText("Preparing…").assertHasNoClickAction()
    }

    @Test
    @Config(qualifiers = "en-rUS-w240dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun requiredUpdateDetailsRemainReachableWithLargeTextInAShortWindow() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            checkNotNull(app.fixture.heldCheck).complete(Unit)
            app.updates.requireUpdate(RequiredUpdate("99.0.0"))
            compose.waitUntil(10_000) {
                val state = app.updates.state.value
                state.required && state.canDownload
            }

            val action = compose.onNodeWithText(app.getString(R.string.updates_download))
            val bounds = action.assertIsDisplayed().getUnclippedBoundsInRoot()
            val installed =
                compose.onNodeWithText(
                    app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME),
                )
            installed.performScrollTo().assertIsDisplayed()
            assertEquals(bounds, action.assertIsDisplayed().getUnclippedBoundsInRoot())
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    fun offlineRequiredPageShowsTheInstalledVersionDuringDiscovery() {
        val discovery = checkNotNull(app.fixture.heldCheck)
        try {
            app.online.value = false
            app.updates.requireUpdate(RequiredUpdate("99.0.0"))
            compose.waitUntil(10_000) {
                app.updates.state.value.required && app.updates.state.value.offline
            }
            compose.onNodeWithText("Update Okou to continue").assertIsDisplayed()
            compose
                .onNodeWithText("Current version: ${BuildConfig.VERSION_NAME}")
                .assertIsDisplayed()
            compose
                .onNodeWithText("Connect to the internet to check for updates.")
                .assertIsDisplayed()
            compose.onNodeWithText("Waiting to check").assertIsNotEnabled()
            compose.onNodeWithText("You are up to date").assertDoesNotExist()

            app.online.value = true
            discovery.complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }
            compose.onNodeWithText("Download update").assertIsEnabled()
        } finally {
            discovery.complete(Unit)
        }
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
            compose.onNodeWithText(compose.activity.getString(R.string.app_name)).assertExists()
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
        compose.onNodeWithText("Download update").assertIsDisplayed().performClick()
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
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_RETURN_RESULT, false))
        returnFrom(install.requestCode, Activity.RESULT_FIRST_USER)
        compose.onNodeWithText("Android could not install the update.").assertIsDisplayed()
        compose.onNodeWithText("Continue installation").assertIsEnabled().performClick()
        val retry = nextLaunch()
        assertEquals(intent.data, retry.intent.data)
        returnFrom(retry.requestCode)
        compose.onNodeWithText("Continue installation").assertIsDisplayed()
        assertNoPlatformLaunch()
        assertTrue(app.updates.state.value.required)
        assertTrue(app.updates.state.value.transfer is UpdateTransfer.Ready)
        assertEquals(1, app.fixture.downloadedReleases.size)
    }

    @Test
    fun manualInstallationSurvivesActivityRecreationDuringVerification() {
        val packageManager = shadowOf(app.packageManager)
        packageManager.setCanRequestPackageInstalls(false)
        app.fixture.heldCheck!!.complete(Unit)
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
        compose.onNodeWithText("Download update").performClick()
        finishDownload()
        compose.onNodeWithText("Allow update installation").assertIsDisplayed()
        compose.onNodeWithText("Later").performClick()

        packageManager.setCanRequestPackageInstalls(true)
        val verification = CompletableDeferred<Unit>()
        app.fixture.heldRecovery = verification
        try {
            val install = compose.onNodeWithText("Continue installation")
            install.performClick()
            val preparing = compose.onNodeWithText("Preparing…")
            preparing.assertIsDisplayed().assertHasNoClickAction()
            assertNoPlatformLaunch()
            compose.activityRule.scenario.recreate()
            preparing.assertIsDisplayed().assertHasNoClickAction()
            assertNoPlatformLaunch()

            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            verification.complete(Unit)
            assertNoPlatformLaunch()
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            val launched = nextLaunch()
            assertEquals(Intent.ACTION_VIEW, launched.intent.action)
            returnFrom(launched.requestCode)
            install.assertIsDisplayed().assertIsEnabled()
            assertNoPlatformLaunch()
        } finally {
            verification.complete(Unit)
        }
    }

    @Test
    fun optionalDetailsReturnAfterInstallerCancellationAcrossActivityRecreation() {
        allowInstallAndDiscoverUpdate()
        openUpdateSettings()
        val openDetails = updateSettingsRow()
        val title = updateDetailsHeading()
        val install = updateDetailText("Continue installation")
        openDetails.performScrollTo().performClick()
        compose.onNodeWithText("Download update").performSemanticsAction(SemanticsActions.OnClick)
        finishDownload()
        val pending = nextLaunch()
        compose.activityRule.scenario.recreate()
        returnFrom(pending.requestCode)
        title.assertIsDisplayed()
        install.assertIsDisplayed().assertIsEnabled()
        assertEquals(1, app.fixture.downloadedReleases.size)
        assertNoPlatformLaunch()
    }

    @Test
    fun backgroundCompletionOutsideUpdatesInstallsOnResume() {
        allowInstallAndDiscoverUpdate()
        openUpdateSettings()
        updateSettingsRow().performScrollTo().performClick()
        compose.onNodeWithText("Download update").performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("Close").performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
        compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        finishDownload()
        compose.activityRule.scenario.onActivity {
            assertNull(shadowOf(it).peekNextStartedActivityForResult())
        }
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        val pending = nextLaunch()
        assertEquals(Intent.ACTION_VIEW, pending.intent.action)
        returnFrom(pending.requestCode)
        assertNoPlatformLaunch()
        updateSettingsRow().performScrollTo().performClick()
        updateDetailText("Continue installation").assertIsEnabled()
        assertNoPlatformLaunch()
    }

    private fun openUpdateSettings(viaOverflow: Boolean = true) {
        compose.runOnIdle {
            (app.authentication as TestAuthentication).state.value = testAuthenticationState()
        }
        val entry =
            app.getString(if (viaOverflow) R.string.chat_more_actions else R.string.settings)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithContentDescription(entry).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription(entry).performClick()
        if (viaOverflow) compose.onNodeWithText(app.getString(R.string.settings)).performClick()
    }

    private fun updateSettingsRow() =
        compose.onNode(hasText(app.getString(R.string.updates_title)) and hasClickAction())

    private fun updateDetailText(label: String) =
        compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.Text, listOf(AnnotatedString(label))),
        )

    private fun updateDetailsHeading() =
        compose.onNode(
            hasText(app.getString(R.string.updates_title)) and
                SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading),
        )

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
                ),
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
        compose.waitUntil(10_000) {
            compose.runOnIdle { shadow.peekNextStartedActivityForResult() != null }
        }
        return checkNotNull(compose.runOnIdle { shadow.nextStartedActivityForResult })
    }

    private fun returnFrom(requestCode: Int, resultCode: Int = Activity.RESULT_CANCELED) {
        compose.activityRule.scenario.onActivity {
            assertTrue(it.activityResultRegistry.dispatchResult(requestCode, resultCode, null))
        }
    }

    private fun assertNoPlatformLaunch() {
        compose.runOnIdle {
            assertNull(shadowOf(compose.activity).peekNextStartedActivityForResult())
        }
    }
}
