package ai.okou.android.updates

import ai.okou.android.BuildConfig
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
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
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
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

    override val updates by lazy {
        AppUpdates(
            fixture,
            MemoryUpdateStore(),
            BuildConfig.VERSION_NAME,
            Build.VERSION.SDK_INT,
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
    fun updateToolbarRestoresKeyboardFocusAfterClosingDetails() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            compose.runOnIdle {
                (app.authentication as TestAuthentication).state.value = testAuthenticationState()
                app.fixture.response =
                    AndroidUpdates(
                        null,
                        updateRelease("99.0.0").copy(minimumSdk = Build.VERSION.SDK_INT + 1L),
                    )
            }
            checkNotNull(app.fixture.heldCheck).complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.available }

            val toolbar =
                compose.onNodeWithContentDescription(
                    app.getString(R.string.updates_android_unsupported),
                )
            assertEquals(
                app.getString(R.string.updates_title),
                toolbar.fetchSemanticsNode().config[SemanticsActions.OnClick].label,
            )
            toolbar
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .assertIsFocused()
                .performKeyInput { pressKey(Key.Enter) }
            updateDetailsHeading().assertIsDisplayed()
            updateDetailText("Close")
                .performSemanticsAction(SemanticsActions.RequestFocus)
                .performKeyInput { pressKey(Key.Enter) }
            updateDetailsHeading().assertDoesNotExist()
            toolbar.assertIsFocused()
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
    @Config(qualifiers = "en-rUS-w360dp-h640dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun extremelyShortUpdateDetailsKeepTheReaderAndActionsInPlaceOnFailure() {
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        val originalFontScale = RuntimeEnvironment.getFontScale()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            allowInstallAndDiscoverUpdate()
            openUpdateSettings()
            updateSettingsRow().performScrollTo().performClick()
            updateDetailsHeading().assertIsDisplayed()
            RuntimeEnvironment.setQualifiers("en-rUS-w360dp-h160dp")
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()

            val close = updateDetailText(app.getString(R.string.updates_close))
            val download = updateDetailText(app.getString(R.string.updates_download))
            val closeBounds = close.assertIsDisplayed().getUnclippedBoundsInRoot()
            val downloadBounds = download.assertIsDisplayed().getUnclippedBoundsInRoot()
            val title = updateDetailsHeading()
            val titleTop = title.getUnclippedBoundsInRoot().top
            val installed = app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME)
            val reader = compose.onNode(hasScrollAction() and hasAnyDescendant(hasText(installed)))
            reader.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            val scroll =
                reader.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
            val initialOffset = scroll.value()
            reader.performKeyInput { pressKey(Key.PageDown) }
            compose.waitUntil(5_000) { scroll.value() > initialOffset }
            val readingTitleTop = title.getUnclippedBoundsInRoot().top
            val readingOffset = scroll.value()
            assertTrue(readingTitleTop < titleTop)

            compose.runOnIdle {
                app.fixture.failCheck = true
                app.updates.check()
            }
            val error = updateDetailText(app.getString(R.string.updates_error_check)).assertExists()
            assertEquals(readingOffset, scroll.value())
            assertEquals(readingTitleTop, title.getUnclippedBoundsInRoot().top)
            reader.assertIsFocused()
            assertEquals(closeBounds, close.assertIsDisplayed().getUnclippedBoundsInRoot())
            assertEquals(
                downloadBounds,
                download.assertIsDisplayed().assertIsEnabled().getUnclippedBoundsInRoot(),
            )
            error.performScrollTo().assertIsDisplayed()
            close.performClick()
            title.assertDoesNotExist()
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
            RuntimeEnvironment.setFontScale(originalFontScale)
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w360dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortUpdateDetailsKeepTheCurrentVersionInViewOnFailure() {
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
            val installed =
                updateDetailText(
                    app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME),
                )
            val installedBounds = installed.assertIsDisplayed().getUnclippedBoundsInRoot()
            val headingBounds = heading.assertIsDisplayed().getUnclippedBoundsInRoot()
            val closeBounds = close.assertIsDisplayed().getUnclippedBoundsInRoot()
            compose.runOnIdle { app.fixture.failCheck = true }
            updateDetailText("Check versions").performClick()
            val error = updateDetailText(app.getString(R.string.updates_error_check)).assertExists()
            assertEquals(
                LiveRegionMode.Polite,
                error.fetchSemanticsNode().config[SemanticsProperties.LiveRegion],
            )
            updateDetailText("Retry check").assertIsEnabled()
            assertEquals(installedBounds, installed.assertIsDisplayed().getUnclippedBoundsInRoot())
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            assertEquals(closeBounds, close.getUnclippedBoundsInRoot())
            error.performScrollTo().assertIsDisplayed()
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w340dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortUpdateDetailsRetainReadingPositionWhenDiscoveringAnUpdate() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(1.5f)
            compose.activityRule.scenario.recreate()
            val release = updateRelease("99.1234.5678").copy(size = 123_456_789)
            compose.runOnIdle { app.fixture.response = AndroidUpdates(null, release) }
            openUpdateSettings()
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
            assertEquals(installedTop, installed.assertIsDisplayed().getUnclippedBoundsInRoot().top)
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            assertEquals(closeBounds, close.getUnclippedBoundsInRoot())
            assertEquals(
                actionBounds,
                updateDetailText("Download update").getUnclippedBoundsInRoot(),
            )
            version.performScrollTo().assertIsDisplayed()
            size.performScrollTo().assertIsDisplayed()
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "w240dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun requiredUpdateActionIsReachableInACompactWindow() {
        app.updates.requireUpdate(RequiredUpdate("99.0.0"))
        compose.waitUntil(10_000) {
            val state = app.updates.state.value
            state.required && state.check == UpdateCheck.Checking
        }
        val progress =
            compose.onNode(
                SemanticsMatcher.expectValue(
                    SemanticsProperties.ProgressBarRangeInfo,
                    ProgressBarRangeInfo.Indeterminate,
                ),
            )
        fun progressFillsCorner(): Boolean {
            val pixels = progress.assertIsDisplayed().captureToImage().toPixelMap()
            // A point outside the full-screen action's pill.
            val (x, y) = with(compose.density) { 8.dp.roundToPx() to 3.dp.roundToPx() }
            return pixels[x, y] == pixels[pixels.width / 2, y]
        }
        assertFalse("Checking uses the full-screen entry pill", progressFillsCorner())

        checkNotNull(app.fixture.heldCheck).complete(Unit)
        compose.waitUntil(10_000) { app.updates.state.value.canDownload }
        val update = compose.onNodeWithText("Download update")
        compose.onNodeWithText("Update required").assertIsDisplayed()
        val bounds = update.assertIsDisplayed().getUnclippedBoundsInRoot()
        update.performClick()
        compose.waitUntil(10_000) { app.updates.state.value.transfer is UpdateTransfer.Downloading }
        assertEquals(bounds, progress.assertIsDisplayed().getUnclippedBoundsInRoot())
        assertFalse(
            "Preparing the download keeps the full-screen action shape",
            progressFillsCorner(),
        )
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
            compose.onNodeWithText(app.getString(R.string.updates_required_short)).performScrollTo()
            action.performClick()
            val preparing = compose.onNodeWithText(app.getString(R.string.updates_preparing))
            assertEquals(bounds, preparing.assertIsDisplayed().getUnclippedBoundsInRoot())
            app.fixture.transfer.completeExceptionally(UpdateException(UpdateProblem.Integrity))
            compose
                .onNodeWithText(app.getString(R.string.updates_error_integrity))
                .performScrollTo()
                .assertIsDisplayed()
            val retry = compose.onNodeWithText(app.getString(R.string.updates_retry_download))
            assertEquals(
                bounds,
                retry.assertIsDisplayed().assertIsEnabled().getUnclippedBoundsInRoot(),
            )
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w380dp-h320dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun aRequiredUpdateCheckFailureKeepsTheReaderPositionAndFocus() {
        val originalFontScale = RuntimeEnvironment.getFontScale()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            val release = updateRelease("99.0.0").copy(minimumSdk = 36)
            compose.runOnIdle {
                app.fixture.response = AndroidUpdates(null, release)
                app.updates.requireUpdate(RequiredUpdate("99.0.0"))
                checkNotNull(app.fixture.heldCheck).complete(Unit)
            }
            compose.waitUntil(10_000) {
                app.updates.state.value.let {
                    it.required && it.check == UpdateCheck.Checked && it.candidate == release
                }
            }
            val heading =
                compose.onNodeWithText(app.getString(R.string.updates_required_incompatible_short))
            val headingBounds = heading.assertIsDisplayed().getUnclippedBoundsInRoot()
            val action = compose.onNodeWithText(app.getString(R.string.updates_check_compatible))
            val actionBounds = action.assertIsDisplayed().getUnclippedBoundsInRoot()
            val reader = compose.onNode(hasScrollAction())
            fun outlinePixel() =
                reader.captureToImage().toPixelMap().let {
                    val inset = with(compose.density) { 2.dp.roundToPx() }
                    it[inset, it.height / 2]
                }
            val unfocusedPixel = outlinePixel()
            reader.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            assertNotEquals(unfocusedPixel, outlinePixel())
            val scroll =
                reader.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
            val initialOffset = scroll.value()
            reader.performKeyInput { pressKey(Key.PageDown) }
            compose.waitUntil(5_000) { scroll.value() > initialOffset }
            val installed =
                compose.onNodeWithText(
                    app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME),
                )
            val installedBounds =
                installed.performScrollTo().assertIsDisplayed().getUnclippedBoundsInRoot()
            val readingOffset = scroll.value()

            compose.runOnIdle {
                app.fixture.failCheck = true
                app.updates.check()
            }
            val error = updateDetailText(app.getString(R.string.updates_error_check)).assertExists()
            assertEquals(readingOffset, scroll.value())
            assertEquals(installedBounds, installed.assertIsDisplayed().getUnclippedBoundsInRoot())
            reader.assertIsFocused()
            assertEquals(headingBounds, heading.getUnclippedBoundsInRoot())
            val retry = compose.onNodeWithText(app.getString(R.string.updates_retry_check))
            assertEquals(actionBounds, retry.assertIsDisplayed().getUnclippedBoundsInRoot())
            error.performScrollTo().assertIsDisplayed()
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun requiredPageShowsTheInstalledVersionAndAllowsImmediateCheckAndDownloadRetries() {
        val discovery = checkNotNull(app.fixture.heldCheck)
        val retryDiscovery = CompletableDeferred<Unit>()
        val limited = ApiFailure.Http(429, null, null, 60)
        try {
            app.updates.requireUpdate(RequiredUpdate("99.0.0"))
            compose.waitUntil(10_000) {
                app.updates.state.value.let { it.required && it.check == UpdateCheck.Checking }
            }
            compose.onNodeWithText("Update Okou to continue").assertIsDisplayed()
            compose
                .onNodeWithText("Current version: ${BuildConfig.VERSION_NAME}")
                .assertIsDisplayed()
            compose.onNodeWithText("Checking…").assertIsDisplayed()
            compose.onNodeWithText("You are up to date").assertDoesNotExist()

            compose.runOnIdle {
                app.fixture.checkRejection = limited
                discovery.complete(Unit)
            }
            compose.waitUntil(10_000) { app.updates.state.value.check == UpdateCheck.Waiting }
            compose.runOnIdle {
                app.fixture.checkRejection = null
                app.fixture.heldCheck = retryDiscovery
            }
            compose.onNodeWithText("Retry check").assertIsEnabled().performClick()
            compose.waitUntil(10_000) { app.updates.state.value.check == UpdateCheck.Checking }
            compose.onNodeWithText("Checking…").assertIsDisplayed()

            retryDiscovery.complete(Unit)
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }
            val release = checkNotNull(app.updates.state.value.candidate)
            compose.onNodeWithText("Download update").assertIsEnabled().performClick()
            compose.runOnIdle { app.fixture.transfer.completeExceptionally(limited) }
            compose.waitUntil(10_000) {
                app.updates.state.value.transfer == UpdateTransfer.Waiting(release)
            }
            compose.runOnIdle { app.fixture.transfer = CompletableDeferred() }
            compose.onNodeWithText("Retry download").assertIsEnabled().performClick()
            compose.waitUntil(10_000) {
                app.updates.state.value.transfer == UpdateTransfer.Downloading(release)
            }
            compose.onNodeWithText("Preparing…").assertIsDisplayed()
        } finally {
            discovery.complete(Unit)
            retryDiscovery.complete(Unit)
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
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
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
            val actionBounds = install.getUnclippedBoundsInRoot()
            install.performClick()
            val waiting = compose.onNodeWithText("Waiting to install")
            waiting.assertIsDisplayed().assertIsNotEnabled().assertHasNoClickAction()
            assertEquals(actionBounds, waiting.getUnclippedBoundsInRoot())
            fun actionFill(label: String) =
                compose.onNodeWithText(label).captureToImage().toPixelMap().let { pixels ->
                    pixels[pixels.width / 8, pixels.height / 2]
                }
            val waitingFill = actionFill("Waiting to install")
            assertNoPlatformLaunch()
            compose.activityRule.scenario.recreate()
            waiting.assertIsDisplayed().assertIsNotEnabled()
            assertNoPlatformLaunch()

            compose.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            verification.complete(Unit)
            assertNoPlatformLaunch()
            compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            val launched = nextLaunch()
            assertEquals(Intent.ACTION_VIEW, launched.intent.action)
            assertEquals(waitingFill, actionFill("Installing…"))
            returnFrom(launched.requestCode)
            install.assertIsDisplayed().assertIsEnabled()
            assertNoPlatformLaunch()
        } finally {
            verification.complete(Unit)
        }
    }

    @Test
    fun anObsoleteVerificationDoesNotDelayInstallingACompatibleReplacement() {
        allowInstallAndDiscoverUpdate()
        val first = updateRelease("99.0.0")
        val replacement = updateRelease("99.1.0")
        val obsolete = CompletableDeferred<Unit>()
        try {
            compose.runOnIdle {
                app.fixture.heldRecovery = obsolete
                app.updates.requireUpdate(RequiredUpdate(first.version))
            }
            val download = compose.onNodeWithText("Download update")
            download.assertIsDisplayed().performClick()
            finishDownload()
            compose.waitUntil(10_000) {
                compose.runOnIdle { first in app.fixture.recoveredReleases }
            }
            compose.onNodeWithText("Waiting to install").assertIsNotEnabled()
            assertNoPlatformLaunch()

            compose.runOnIdle {
                app.fixture.heldRecovery = null
                app.fixture.transfer = CompletableDeferred()
                app.fixture.response = AndroidUpdates(replacement.version, replacement)
                app.updates.requireUpdate(RequiredUpdate(replacement.version))
            }
            compose.waitUntil(10_000) {
                app.updates.state.value.let { it.candidate == replacement && it.canDownload }
            }
            download.assertIsEnabled().performClick()
            finishDownload("replacement.apk")
            val installer = nextLaunch()
            assertEquals(Intent.ACTION_VIEW, installer.intent.action)
            assertEquals("replacement.apk", installer.intent.data?.lastPathSegment)
            assertFalse(obsolete.isCompleted)

            obsolete.complete(Unit)
            compose.onNodeWithText("Installing…").assertIsDisplayed()
            returnFrom(installer.requestCode)
            compose.onNodeWithText("Continue installation").assertIsDisplayed().assertIsEnabled()
            assertNoPlatformLaunch()
        } finally {
            obsolete.complete(Unit)
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
    fun installFocusFollowsItsSlotUntilTheUserMovesToClose() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            allowInstallAndDiscoverUpdate()
            openUpdateSettings()
            updateSettingsRow().performScrollTo().performClick()

            val download = updateDetailText("Download update")
            download.performSemanticsAction(SemanticsActions.RequestFocus).assertIsFocused()
            download.performKeyInput { pressKey(Key.Enter) }
            finishDownload()
            val first = nextLaunch()
            returnFrom(first.requestCode)
            val install = updateDetailText("Continue installation")
            install.assertIsFocused()

            val verification = CompletableDeferred<Unit>()
            try {
                compose.runOnIdle { app.fixture.heldRecovery = verification }
                install.performKeyInput { pressKey(Key.Enter) }
                val waiting = updateDetailText("Waiting to install")
                waiting.assertIsFocused().performKeyInput { pressKey(Key.DirectionLeft) }
                val close = updateDetailText("Close")
                close.assertIsFocused()
                verification.complete(Unit)
                val second = nextLaunch()
                returnFrom(second.requestCode)
                install.assertIsEnabled()
                close.assertIsFocused()
            } finally {
                verification.complete(Unit)
            }
        } finally {
            instrumentation.resetInTouchMode()
        }
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

    private fun openUpdateSettings() {
        compose.runOnIdle {
            (app.authentication as TestAuthentication).state.value = testAuthenticationState()
        }
        val entry = app.getString(R.string.chat_more_actions)
        compose.waitUntil(10_000) {
            compose.onAllNodesWithContentDescription(entry).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription(entry).performClick()
        compose.onNodeWithText(app.getString(R.string.settings)).performClick()
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

    private fun finishDownload(name: String = "install.apk") {
        // The sandbox uses a new private files directory for each test in the same classloader.
        val provider =
            checkNotNull(
                app.packageManager.resolveContentProvider(
                    "${app.packageName}.updates",
                    PackageManager.GET_META_DATA,
                ),
            )
        FileProvider().attachInfo(app, provider)
        val file = File(app.filesDir, "updates/$name")
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
