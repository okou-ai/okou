package ai.okou.android

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.RequiredUpdate
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateCheck
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import ai.okou.android.updates.UpdateTransfer
import android.app.UiModeManager
import android.content.res.Configuration
import android.graphics.Rect
import android.text.format.Formatter
import android.view.KeyEvent
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeUpdateTest {
    @Test
    fun aReadyUpdateShowsTheWaitingActionAcrossUpdateSurfaces() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val download = CompletableDeferred<Unit>()
        val release = nativeUpdateRelease()
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize(retainedRelease: AndroidUpdatesRelease?) = Unit

                    override suspend fun check() = AndroidUpdates(null, release)

                    override suspend fun recover(release: AndroidUpdatesRelease): File? =
                        error("A paused Activity cannot start the install handoff")

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File {
                        download.await()
                        return File(app.filesDir, "updates/native-update-fixture.apk")
                    }

                    override fun close() = Unit
                },
                EmptyUpdateStore,
                BuildConfig.VERSION_NAME,
                35,
            )
        val previous = app.updateOwner
        var scenario: ActivityScenario<MainActivity>? = null
        val failures = mutableListOf<Throwable>()
        try {
            app.updateOwner = owner
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity
            fun find(selector: BySelector): UiObject2 =
                checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                    "Expected update state $selector"
                }
            fun text(id: Int) = By.pkg(app.packageName).text(app.getString(id))

            device.awaitChatList(app)
            val update =
                device.enabledUpdateControl(
                    By.pkg(app.packageName).desc(app.getString(R.string.updates_download)),
                )
            val toolbarBounds = update.visibleBounds
            update.click()
            device
                .enabledUpdateControl(
                    By.pkg(app.packageName).desc(app.getString(R.string.updates_downloading, "0%")),
                )
                .click()
            find(text(R.string.updates_preparing))
            instrumentation.setInTouchMode(false)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
            device.awaitKeyboardFocus(text(R.string.updates_close))

            // Exercise the paused, still visible window without another Activity covering it.
            activity.onActivity {
                instrumentation.callActivityOnPause(it)
                assertEquals(Lifecycle.State.STARTED, it.lifecycle.currentState)
            }
            download.complete(Unit)
            val waiting = text(R.string.updates_waiting_to_install)
            fun assertNoWaitAction(control: UiObject2) {
                assertFalse(
                    generateSequence(control) { it.parent }.any { it.isClickable && it.isEnabled },
                )
            }
            assertNoWaitAction(find(waiting))
            device.awaitKeyboardFocus(text(R.string.updates_close))
            captureUpdate(device, "details-waiting-to-install")
            assertTrue(device.pressDPadCenter())
            val toolbar =
                find(
                    By.pkg(app.packageName)
                        .desc(app.getString(R.string.updates_waiting_to_install)),
                )
            assertNoWaitAction(toolbar)
            assertEquals(toolbarBounds, toolbar.visibleBounds)
            captureUpdate(device, "toolbar-waiting-to-install")

            owner.requireUpdate(RequiredUpdate(release.version))
            find(text(R.string.updates_required))
            assertNoWaitAction(find(waiting))
            captureUpdate(device, "required-waiting-to-install")
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("android-update-install-wait-failure")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            download.cancel()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { instrumentation.resetInTouchMode() },
                    { app.updateOwner = previous },
                    { owner.close() },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun updateSharesProgressInstallsFromSearchAndKeepsTheRequiredGateAcrossRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val initialization = CompletableDeferred<Unit>()
        val gate = CompletableDeferred<Unit>()
        val heldCheck = AtomicReference<CompletableDeferred<Unit>?>(null)
        val firstProgress = CompletableDeferred<Unit>()
        val download = AtomicReference(CompletableDeferred<File>())
        val release = nativeUpdateRelease()
        val failNextCheck = AtomicBoolean(true)
        val candidate = AtomicReference(release.copy(version = BuildConfig.VERSION_NAME))
        val file = File(app.filesDir, "updates/native-update-fixture.apk")
        val owner =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize(retainedRelease: AndroidUpdatesRelease?) {
                        initialization.await()
                    }

                    override suspend fun check(): AndroidUpdates {
                        gate.await()
                        heldCheck.get()?.await()
                        if (failNextCheck.getAndSet(false))
                            throw IOException("fixture check failed")
                        return AndroidUpdates(null, candidate.get())
                    }

                    override suspend fun recover(release: AndroidUpdatesRelease): File? =
                        file.takeIf(File::isFile)

                    override suspend fun download(
                        release: AndroidUpdatesRelease,
                        progress: (Long) -> Unit,
                    ): File {
                        firstProgress.await()
                        progress(release.size * 53 / 100)
                        return download.get().await()
                    }

                    override fun close() = Unit
                },
                EmptyUpdateStore,
                BuildConfig.VERSION_NAME,
                35,
            )
        val previous = app.updateOwner
        app.updateOwner = owner
        var scenario: ActivityScenario<MainActivity>? = null
        val mode = requireNotNull(app.getSystemService(UiModeManager::class.java))
        val nightMode = mode.nightMode
        val automation = instrumentation.uiAutomation
        var adoptedNightModePermission = false
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun find(label: BySelector) = device.wait(Until.findObject(label), 10_000)
            fun text(value: String) = find(By.pkg(app.packageName).text(value))
            fun button(label: BySelector): UiObject2 = device.enabledUpdateControl(label)
            fun click(label: Int) =
                button(By.pkg(app.packageName).text(app.getString(label))).click()
            fun exists(label: Int) = assertNotNull(text(app.getString(label)))
            fun revealSettingsUpdate(label: String) {
                val target = By.pkg(app.packageName).text(label)
                if (device.hasObject(target)) return
                val settings = checkNotNull(find(By.pkg(app.packageName).scrollable(true)))
                val visible =
                    object : Condition<UiObject2, Boolean> {
                        override fun apply(container: UiObject2) = device.hasObject(target)
                    }
                assertTrue(
                    "Expected Settings update control $label",
                    settings.scrollUntil(Direction.DOWN, visible) == true,
                )
            }
            fun captureState(name: String) = captureUpdate(device, name)
            fun focusReadingRegion() {
                val reader = By.pkg(app.packageName).scrollable(true).focused(true)
                repeat(3) {
                    if (device.hasObject(reader)) return
                    assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_TAB))
                    if (device.wait(Until.hasObject(reader), 1_000)) return
                }
                assertNotNull(find(reader))
            }
            fun withShortWindowAndLargeText(width: Int, height: Int = 850, block: () -> Unit) {
                val originalSize =
                    device
                        .executeShellCommand("wm size")
                        .substringAfter("Override size: ", "")
                        .trim()
                val fontScale = device.executeShellCommand("settings get system font_scale").trim()
                try {
                    device.executeShellCommand("wm size ${width}x${height}")
                    device.executeShellCommand("settings put system font_scale 2.0")
                    val resized =
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) =
                                device.displayWidth == width &&
                                    device.displayHeight == height &&
                                    app.resources.configuration.fontScale >= 2f
                        }
                    assertTrue(device.wait(resized, 10_000) == true)
                    block()
                } finally {
                    if (fontScale.toFloatOrNull() == null)
                        device.executeShellCommand("settings delete system font_scale")
                    else device.executeShellCommand("settings put system font_scale $fontScale")
                    device.executeShellCommand("wm size ${originalSize.ifBlank { "reset" }}")
                }
            }
            device.awaitChatList(app)
            val searchLabel = app.getString(R.string.chat_search_workspace)
            val search = By.pkg(app.packageName).desc(searchLabel)
            val searchBounds = button(search).visibleBounds
            val density = app.resources.displayMetrics.density
            fun assertGap(expectedDp: Int, actualPx: Int) {
                // Compose rounds layout spacing first. UI Automator rounds each edge separately.
                val expectedPx = (expectedDp * density).roundToInt()
                assertEquals(expectedPx.toFloat(), actualPx.toFloat(), 1f)
            }
            val avatar =
                By.pkg(app.packageName)
                    .descStartsWith(app.getString(R.string.auth_switch_workspace))
            val filterAction = By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
            assertGap(8, searchBounds.left - button(avatar).visibleBounds.right)
            assertGap(8, button(filterAction).visibleBounds.left - searchBounds.right)
            captureState("toolbar-current")
            val updateTarget = app.getString(R.string.updates_version, "99.0.0")
            val installedVersion =
                app.getString(R.string.updates_installed, BuildConfig.VERSION_NAME)
            val close = By.pkg(app.packageName).text(app.getString(R.string.updates_close))
            fun detailsBounds() =
                checkNotNull(text(installedVersion)).visibleBounds to button(close).visibleBounds
            fun closeDetails() {
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                assertTrue(
                    "Back did not dismiss the update details",
                    device.wait(Until.gone(close), 10_000),
                )
                button(By.pkg(app.packageName).text(app.getString(R.string.updates_title)))
            }
            fun backToChatList() {
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                device.awaitChatList(app)
            }
            device.openChatListSettings(app)
            val noUpdateNeeded = app.getString(R.string.updates_not_needed)
            val updateNeeded = app.getString(R.string.updates_needed)
            val checking = app.getString(R.string.updates_check_in_progress)
            val checkFailed = app.getString(R.string.updates_status_check_failed)
            val settingsUpdate = By.pkg(app.packageName).text(app.getString(R.string.updates_title))
            revealSettingsUpdate(app.getString(R.string.updates_title))
            val settingsUpdateBounds = button(settingsUpdate).visibleBounds
            fun assertSettingsRowSize() {
                val bounds = button(settingsUpdate).visibleBounds
                assertEquals(settingsUpdateBounds.width(), bounds.width())
                assertEquals(settingsUpdateBounds.height(), bounds.height())
            }
            assertFalse(device.hasObject(By.pkg(app.packageName).text(noUpdateNeeded)))
            captureState("settings-unchecked")
            click(R.string.updates_title)
            button(By.pkg(app.packageName).text(app.getString(R.string.updates_check)))
            assertFalse(
                device.hasObject(
                    By.pkg(app.packageName).text(app.getString(R.string.updates_current)),
                ),
            )
            captureState("details-unchecked")
            val initialDetailsBounds = detailsBounds()
            initialization.complete(Unit)
            exists(R.string.updates_check_in_progress)
            captureState("details-checking")
            assertEquals(initialDetailsBounds, detailsBounds())
            closeDetails()
            revealSettingsUpdate(checking)
            assertSettingsRowSize()
            captureState("settings-checking")
            click(R.string.updates_title)
            exists(R.string.updates_check_in_progress)
            gate.complete(Unit)
            exists(R.string.updates_error_check)
            button(By.pkg(app.packageName).text(app.getString(R.string.updates_retry_check)))
            captureState("details-check-failed")
            assertEquals(initialDetailsBounds, detailsBounds())
            closeDetails()
            assertNotNull(text(checkFailed))
            assertSettingsRowSize()
            captureState("settings-check-failed")
            click(R.string.updates_title)
            exists(R.string.updates_error_check)
            assertEquals(initialDetailsBounds, detailsBounds())
            captureState("details-reopened-check-failed")
            click(R.string.updates_retry_check)
            exists(R.string.updates_current)
            captureState("details-up-to-date")
            assertEquals(initialDetailsBounds, detailsBounds())
            closeDetails()
            assertNotNull(text(noUpdateNeeded))
            assertSettingsRowSize()
            captureState("settings-current")
            candidate.set(release.copy(minimumSdk = 36))
            val recheck = CompletableDeferred<Unit>()
            heldCheck.set(recheck)
            click(R.string.updates_title)
            exists(R.string.updates_current)
            assertEquals(initialDetailsBounds, detailsBounds())
            click(R.string.updates_check)
            exists(R.string.updates_check_in_progress)
            assertEquals(initialDetailsBounds, detailsBounds())
            captureState("details-manual-checking")
            recheck.complete(Unit)
            exists(R.string.updates_android_unsupported)
            assertNotNull(text(updateTarget))
            assertNotNull(
                text(
                    app.getString(
                        R.string.updates_package_size,
                        Formatter.formatShortFileSize(app, release.size),
                    ),
                ),
            )
            captureState("details-incompatible")
            closeDetails()
            backToChatList()
            val incompatibleToolbar =
                By.pkg(app.packageName).desc(app.getString(R.string.updates_android_unsupported))
            button(incompatibleToolbar)
            captureState("toolbar-incompatible")
            button(incompatibleToolbar).click()
            exists(R.string.updates_check_compatible)
            captureState("toolbar-incompatible-details")

            candidate.set(release)
            click(R.string.updates_check_compatible)
            exists(R.string.updates_download)
            assertNotNull(text(updateTarget))
            device.waitForIdle()
            assertEquals(initialDetailsBounds, detailsBounds())

            val downloadLabel =
                By.pkg(app.packageName).text(app.getString(R.string.updates_download))
            val downloadBounds = button(downloadLabel).visibleBounds
            val checkError =
                By.pkg(app.packageName).text(app.getString(R.string.updates_error_check))
            failNextCheck.set(true)
            instrumentation.runOnMainSync { owner.check() }
            val latestError = checkNotNull(device.wait(Until.findObject(checkError), 10_000))
            val availableVersion = checkNotNull(text(updateTarget))
            assertTrue(latestError.visibleBounds.top >= availableVersion.visibleBounds.bottom)
            assertEquals(downloadBounds, button(downloadLabel).visibleBounds)
            assertEquals(initialDetailsBounds, detailsBounds())
            captureState("details-compatible-check-failed")
            instrumentation.runOnMainSync { owner.check() }
            assertTrue(device.wait(Until.gone(checkError), 10_000))
            click(R.string.updates_close)
            assertTrue(device.wait(Until.gone(close), 10_000))

            val updateAction = app.getString(R.string.updates_download)
            val updateSelector = By.pkg(app.packageName).desc(updateAction)
            val updateBounds = button(updateSelector).visibleBounds
            fun captureAlignedUpdate(name: String, bounds: Rect, searchField: Rect) {
                assertGap(48, bounds.width())
                assertEquals(searchField.top, bounds.top)
                assertEquals(searchField.bottom, bounds.bottom)
                val primary =
                    resolvePalette(UserPreferencesColorTheme.DEFAULT, dark = false).primary.toArgb()
                device.waitForIdle()
                val screenshot = takeScreenshot()
                try {
                    // Sample inside the painted container, above the icon or progress label.
                    assertEquals(primary, screenshot.getPixel(bounds.centerX(), bounds.top + 2))
                    screenshot.writeToTestStorage("android-update-$name")
                } finally {
                    screenshot.recycle()
                }
            }
            assertEquals(searchBounds, button(search).visibleBounds)
            assertGap(48, updateBounds.height())
            assertGap(8, updateBounds.left - searchBounds.right)
            captureAlignedUpdate("toolbar-available", updateBounds, searchBounds)
            withShortWindowAndLargeText(width = 1000, height = 1600) {
                val scaledSearch = button(search).visibleBounds
                assertTrue(scaledSearch.height() > searchBounds.height())
                captureAlignedUpdate(
                    "toolbar-available-large-text",
                    button(updateSelector).visibleBounds,
                    scaledSearch,
                )
            }
            device.enabledUpdateControl(updateSelector, expectedBounds = updateBounds)
            assertTrue(
                device.wait(Until.gone(By.desc(app.getString(R.string.chat_filter))), 10_000),
            )
            val more =
                button(By.pkg(app.packageName).desc(app.getString(R.string.chat_more_actions)))
            assertGap(4, more.visibleBounds.left - updateBounds.right)
            assertEquals(1, device.findObjects(By.pkg(app.packageName).desc(updateAction)).size)
            assertFalse(
                device.hasObject(By.pkg(app.packageName).desc(app.getString(R.string.settings))),
            )
            more.click()
            val filter = app.getString(R.string.chat_filter)
            val inbox = app.getString(R.string.chat_inbox)
            val muted = app.getString(R.string.chat_muted)
            fun awaitMenuFocus(label: String) =
                device.awaitKeyboardFocus(By.pkg(app.packageName).text(label))
            assertNotNull(text(filter))
            assertNotNull(text(app.getString(R.string.chat_project_create)))
            assertNotNull(text(app.getString(R.string.settings)))
            instrumentation.setInTouchMode(false)
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END))
            awaitMenuFocus(muted)
            assertTrue(device.pressDPadDown())
            awaitMenuFocus(inbox)
            assertTrue(device.pressDPadUp())
            awaitMenuFocus(muted)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_HOME))
            awaitMenuFocus(inbox)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ESCAPE))
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            // A popup can close without emitting the accessibility event that pressBack awaits.
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitMenuFocus(filter)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            val moreLabel = app.getString(R.string.chat_more_actions)
            device.awaitKeyboardFocus(By.pkg(app.packageName).desc(moreLabel))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(filter)), 10_000))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_DPAD_LEFT))
            device.awaitKeyboardFocus(By.pkg(app.packageName).desc(updateAction))
            captureState("toolbar-focused")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_DPAD_RIGHT))
            device.awaitKeyboardFocus(By.pkg(app.packageName).desc(moreLabel))
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(filter)
            assertTrue(device.pressDPadCenter())
            awaitMenuFocus(inbox)
            // Dismissing a popup can leave no accessibility acknowledgement for UiDevice.click.
            device.click(updateBounds.centerX(), updateBounds.centerY())
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(inbox)), 10_000))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(filter)), 10_000))
            assertFalse(device.hasObject(By.pkg(app.packageName).text(updateTarget)))
            fun openOverflow() =
                requireNotNull(device.wait(Until.findObject(By.desc(moreLabel)), 10_000)).click()
            openOverflow()
            click(R.string.settings)
            revealSettingsUpdate(updateNeeded)
            assertSettingsRowSize()
            captureState("settings-available")
            click(R.string.updates_title)
            assertNotNull(text(updateTarget))
            captureState("details-available")
            closeDetails()
            backToChatList()
            button(By.pkg(app.packageName).desc(updateAction)).click()
            val preparing = app.getString(R.string.updates_preparing)
            val zeroPercent = "0%"
            val initialProgress = app.getString(R.string.updates_downloading, zeroPercent)
            val progressAtStart = button(By.pkg(app.packageName).desc(initialProgress))
            assertEquals(updateBounds, progressAtStart.visibleBounds)
            assertNotNull(text(zeroPercent))
            captureState("toolbar-starting")
            progressAtStart.click()
            assertNotNull(text(updateTarget))
            assertNotNull(text(preparing))
            captureState("details-preparing")
            firstProgress.complete(Unit)
            val percent = "53%"
            val progressLabel = app.getString(R.string.updates_downloading, percent)
            assertNotNull(text(progressLabel))
            captureState("details-progress")
            click(R.string.updates_close)
            assertTrue(owner.state.value.transfer is UpdateTransfer.Downloading)

            val progress = button(By.pkg(app.packageName).desc(progressLabel))
            assertEquals(updateBounds, progress.visibleBounds)
            assertNotNull(text(percent))
            assertFalse(device.hasObject(By.pkg(app.packageName).text(updateTarget)))
            captureState("toolbar-progress")
            progress.click()
            assertNotNull(text(updateTarget))
            click(R.string.updates_close)

            openOverflow()
            click(R.string.settings)
            revealSettingsUpdate(updateNeeded)
            assertSettingsRowSize()
            captureState("settings-progress")
            backToChatList()

            download.get().completeExceptionally(IOException("fixture download failed"))
            val failed =
                button(
                    By.pkg(app.packageName).desc(app.getString(R.string.updates_download_failed)),
                )
            assertEquals(updateBounds, failed.visibleBounds)
            captureState("toolbar-failed")
            failed.click()
            val targetBounds = checkNotNull(text(updateTarget)).visibleBounds
            val errorBounds =
                checkNotNull(text(app.getString(R.string.updates_error_download))).visibleBounds
            assertTrue(errorBounds.top >= targetBounds.bottom)
            captureState("details-download-failed")
            failNextCheck.set(true)
            instrumentation.runOnMainSync {
                owner.check()
                assertEquals(UpdateCheck.Failed, owner.state.value.check)
            }
            exists(R.string.updates_error_download)
            assertFalse(device.hasObject(checkError))
            assertEquals(initialDetailsBounds, detailsBounds())
            candidate.set(release.copy(version = "99.1.0", minimumSdk = 36))
            instrumentation.runOnMainSync { owner.check() }
            exists(R.string.updates_android_unsupported)
            assertNotNull(text(app.getString(R.string.updates_version, "99.1.0")))
            val downloadError =
                By.pkg(app.packageName).text(app.getString(R.string.updates_error_download))
            assertFalse(device.hasObject(downloadError))
            assertEquals(initialDetailsBounds, detailsBounds())
            captureState("details-replacement-incompatible")
            candidate.set(release)
            click(R.string.updates_check_compatible)
            exists(R.string.updates_download)
            assertNotNull(text(updateTarget))
            assertFalse(device.hasObject(downloadError))
            captureState("details-replacement-download")

            download.set(CompletableDeferred())
            click(R.string.updates_download)
            assertNotNull(text(progressLabel))
            val rateLimited = download.getAndSet(CompletableDeferred())
            rateLimited.completeExceptionally(ApiFailure.Http(429, null, null, 60))
            val waiting = checkNotNull(text(app.getString(R.string.updates_retry_download)))
            assertTrue(
                generateSequence(waiting) { it.parent }.any { it.isClickable && it.isEnabled },
            )
            captureState("details-retry-waiting")
            assertEquals(initialDetailsBounds, detailsBounds())
            withShortWindowAndLargeText(width = 780) {
                exists(R.string.updates_retry_download)
                captureState("details-short-retry-waiting")
            }
            withShortWindowAndLargeText(width = 1000, height = 620) {
                val retry =
                    By.pkg(app.packageName).text(app.getString(R.string.updates_retry_download))
                val footer = button(close).visibleBounds to button(retry).visibleBounds
                val minimumHeight = (48 * density).roundToInt() - 1
                assertTrue(footer.first.height() >= minimumHeight)
                assertTrue(footer.second.height() >= minimumHeight)
                focusReadingRegion()
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_PAGE_UP))
                captureState("details-extreme-short")
                // A page shows only about one line here. Read down to the error from the title.
                repeat(6) {
                    if (!device.hasObject(downloadError)) {
                        assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_PAGE_DOWN))
                        device.wait(Until.hasObject(downloadError), 1_000)
                    }
                }
                exists(R.string.updates_error_download)
                assertEquals(footer, button(close).visibleBounds to button(retry).visibleBounds)
                captureState("details-extreme-short-recovery")
            }
            click(R.string.updates_retry_download)
            assertNotNull(text(progressLabel))
            click(R.string.updates_close)

            button(search).click()
            val searchQuery = "fixture query"
            val searchField =
                requireNotNull(find(By.pkg(app.packageName).clazz("android.widget.EditText")))
            searchField.setText(searchQuery)
            check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
            file.writeText("verified package from the service fixture")
            download.get().complete(file)
            exists(R.string.updates_open_settings)
            captureState("install-permission")
            withShortWindowAndLargeText(width = 1000, height = 900) {
                exists(R.string.updates_allow_install)
                val minTouchHeight = (48 * density).roundToInt() - 1
                for (label in listOf(R.string.updates_later, R.string.updates_open_settings)) {
                    val action = button(By.pkg(app.packageName).text(app.getString(label)))
                    assertTrue(
                        "Expected a visible 48dp target for ${app.getString(label)}",
                        action.visibleBounds.height() >= minTouchHeight,
                    )
                }
                focusReadingRegion()
                captureState("install-permission-short")
            }
            click(R.string.updates_later)
            assertTrue(
                device.wait(
                    Until.gone(
                        By.pkg(app.packageName).text(app.getString(R.string.updates_allow_install)),
                    ),
                    10_000,
                ),
            )
            assertNotNull(text(searchQuery))
            button(By.pkg(app.packageName).desc(app.getString(R.string.back))).click()
            device.awaitChatList(app)
            button(By.pkg(app.packageName).desc(app.getString(R.string.updates_ready)))
            captureState("toolbar-ready")
            openOverflow()
            click(R.string.settings)
            revealSettingsUpdate(updateNeeded)
            assertSettingsRowSize()
            captureState("settings-ready")
            click(R.string.updates_title)
            assertNotNull(text(updateTarget))
            captureState("details-ready")
            closeDetails()

            val activeLocale = app.resources.configuration.locales.toLanguageTags()
            download.set(CompletableDeferred())
            val belowMinimum = release.copy(minimumSdk = 36)
            candidate.set(belowMinimum)
            owner.requireUpdate(RequiredUpdate("99.1.0"))
            val checkVersions =
                By.pkg(app.packageName).text(app.getString(R.string.updates_check_compatible))
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice): Boolean =
                            owner.state.value.let {
                                it.required &&
                                    it.check == UpdateCheck.Checked &&
                                    it.candidate == belowMinimum
                            }
                    },
                    10_000,
                ) == true,
            )
            exists(R.string.updates_unavailable)
            assertFalse(device.hasObject(By.pkg(app.packageName).text(updateTarget)))
            assertFalse(
                device.hasObject(
                    By.pkg(app.packageName)
                        .text(app.getString(R.string.updates_required_incompatible)),
                ),
            )
            val checkVersionsBounds = button(checkVersions).visibleBounds
            captureState("required-no-eligible-version")
            candidate.set(release.copy(version = "99.1.0", minimumSdk = 36))
            button(checkVersions).click()
            exists(R.string.updates_required_incompatible)
            exists(R.string.updates_newer_android_required)
            exists(R.string.updates_required_incompatible_description)
            assertNotNull(text(app.getString(R.string.updates_version, "99.1.0")))
            assertEquals(checkVersionsBounds, button(checkVersions).visibleBounds)
            captureState("required-incompatible")
            withShortWindowAndLargeText(width = 1000) {
                exists(R.string.updates_required_incompatible_short)
                val action = button(checkVersions)
                assertTrue(action.visibleBounds.height() >= (48 * density).roundToInt() - 1)
                focusReadingRegion()
                captureState("required-incompatible-short")
                candidate.set(release.copy(version = "99.1.0"))
                action.click()
                exists(R.string.updates_download)
            }
            exists(R.string.updates_required)
            exists(R.string.updates_download)
            captureState("update-required")
            scenario.recreate()
            exists(R.string.updates_required)
            assertEquals(activeLocale, app.resources.configuration.locales.toLanguageTags())
            assertTrue(owner.state.value.required)
            takeScreenshot().writeToTestStorage("android-update-required-restored")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.pkg(app.packageName)), 10_000))
            scenario.close()
            scenario = ActivityScenario.launch(MainActivity::class.java)
            exists(R.string.updates_required)
            click(R.string.updates_download)
            assertNotNull(text(progressLabel))
            captureState("required-progress")

            automation.adoptShellPermissionIdentity("android.permission.MODIFY_DAY_NIGHT_MODE")
            adoptedNightModePermission = true
            mode.nightMode = UiModeManager.MODE_NIGHT_YES
            val nightConfiguration =
                object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean =
                        (app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                            Configuration.UI_MODE_NIGHT_YES
                }
            assertTrue(device.wait(nightConfiguration, 10_000) == true)
            exists(R.string.updates_required)
            assertNotNull(text(progressLabel))
            captureState("required-progress-dark")
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("android-update-failure")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            initialization.complete(Unit)
            gate.complete(Unit)
            heldCheck.get()?.complete(Unit)
            firstProgress.complete(Unit)
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { owner.close() },
                    { file.delete() },
                    { app.updateOwner = previous },
                    { instrumentation.resetInTouchMode() },
                    { if (adoptedNightModePermission) mode.nightMode = nightMode },
                    { if (adoptedNightModePermission) automation.dropShellPermissionIdentity() },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}

private fun nativeUpdateRelease() =
    AndroidUpdatesRelease(
        "99.0.0",
        24,
        10_200_000,
        "a".repeat(64),
        "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk",
        "",
    )

private object EmptyUpdateStore : UpdateStore {
    override suspend fun load(): UpdateRecord? = null

    override suspend fun save(record: UpdateRecord) = Unit
}

private fun UiDevice.enabledUpdateControl(
    label: BySelector,
    expectedBounds: Rect? = null,
): UiObject2 =
    checkNotNull(
        wait(
            object : Condition<UiDevice, UiObject2?> {
                override fun apply(device: UiDevice): UiObject2? =
                    try {
                        generateSequence(device.findObject(label)) { it.parent }
                            .firstOrNull { it.isClickable }
                            ?.takeIf {
                                it.isEnabled &&
                                    (expectedBounds == null || it.visibleBounds == expectedBounds)
                            }
                    } catch (_: StaleObjectException) {
                        null
                    }
            },
            10_000,
        ),
    ) {
        val bounds = expectedBounds?.let { " with visible bounds $it" }.orEmpty()
        "Expected enabled update control $label$bounds"
    }

private fun captureUpdate(device: UiDevice, name: String) {
    device.waitForIdle()
    takeScreenshot().writeToTestStorage("android-update-$name")
}
