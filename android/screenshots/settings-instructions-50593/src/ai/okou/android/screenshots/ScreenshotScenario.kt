package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.confirmInstructionsDiscard
import ai.okou.android.instructions.InstructionsPhase
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsModel
import ai.okou.android.openChatListSettings
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.graphics.Bitmap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun instructionsCacheEditSaveAndDiscard() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val originalAuthentication = authentication.state.value
        val originalService = app.instructionsService
        val originalStore = app.instructionsStore
        val originalPreferences = app.snapshotApiPreferences()
        val localeManager =
            checkNotNull(app.getSystemService(android.app.LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val preferences =
            testPreferences()
                .copy(locale = UserPreferencesLocale.ZH_HANS, theme = UserPreferencesTheme.LIGHT)
        app.restoreApiPreferences(
            mapOf(Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to preferences),
        )
        val cachedChats =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "instructions-native-").toFile()
        val drafts = PersonalInstructionsDraftStore(app, directory)
        val fixture = InstructionsApiFixture()
        val initialText = "## 回复偏好\n先给结论，再列出接下来需要做的事。"
        fixture.externalEdit(initialText)
        val held = CountDownLatch(1)
        val entered = CountDownLatch(1)
        val refreshHeld = CountDownLatch(1)
        val refreshEntered = CountDownLatch(1)
        val saveReply = CountDownLatch(1)
        val checkReply = CountDownLatch(1)
        val checkEntered = CountDownLatch(1)
        fixture.beforeSave = { saveReply.await() }
        fixture.beforeRead = {
            entered.countDown()
            held.await()
        }
        app.instructionsService = fixture.service
        app.instructionsStore = drafts
        authentication.state.value = testAuthenticationState()
        val device = UiDevice.getInstance(instrumentation)
        var scenario: ActivityScenario<MainActivity>? = null
        lateinit var model: PersonalInstructionsModel
        var editorJob: Job? = null
        var restoreSize: String? = null
        var restoreDensity: String? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000),
                )
            fun reveal(value: String) {
                val target = By.pkg(app.packageName).text(value)
                val scrollable = By.pkg(app.packageName).scrollable(true)
                assertTrue(
                    "Instructions control or scrollable content is visible: $value",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) =
                                device.hasObject(target) || device.hasObject(scrollable)
                        },
                        10_000,
                    ) == true,
                )
                if (!device.hasObject(target)) {
                    val visible =
                        object : Condition<UiObject2, Boolean> {
                            // Compose exposes virtual descendants in the current window.
                            override fun apply(unused: UiObject2) = device.hasObject(target)
                        }
                    if (device.findObject(scrollable)?.scrollUntil(Direction.UP, visible) != true) {
                        device.findObject(scrollable)?.scrollUntil(Direction.DOWN, visible)
                    }
                }
                text(value)
            }
            fun control(id: Int): UiObject2 {
                val label = app.getString(id)
                reveal(label)
                return checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).text(label).enabled(true)),
                        10_000,
                    ),
                )
            }
            fun click(id: Int) = control(id).click()
            fun actionPosition(node: UiObject2): Pair<Int, Int> {
                // Accessibility can expose either the caption or the button as a single node.
                val bounds = node.visibleBounds
                return bounds.centerX() to bounds.centerY()
            }
            fun editor(expectedText: String? = null) =
                checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).clazz("android.widget.EditText").apply {
                                if (expectedText != null) text(expectedText)
                            },
                        ),
                        10_000,
                    ),
                ) {
                    "Instructions editor did not match text=$expectedText"
                }
            fun imeVisible() =
                instrumentation.uiAutomation.windows.any {
                    it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                }
            fun awaitIme(visible: Boolean) {
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean = imeVisible() == visible
                        },
                        10_000,
                    ) == true,
                )
            }
            fun openInstructions() {
                device.awaitChatList(app)
                device.openChatListSettings(app)
                reveal(app.getString(R.string.appearance))
                click(R.string.instructions_title)
            }
            openInstructions()
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            scenario.onActivity {
                model =
                    checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready,
                        )
                        .instructions
                editorJob = model.viewModelScope.coroutineContext[Job]
                assertEquals(InstructionsPhase.Loading, model.uiState.value.phase)
            }
            val placeholder =
                checkNotNull(
                        device.wait(
                            Until.findObject(
                                By.pkg(app.packageName)
                                    .desc(app.getString(R.string.instructions_loading)),
                            ),
                            5_000,
                        ),
                    )
                    .visibleBounds
            val density = app.resources.displayMetrics.density
            assertEquals(112f, placeholder.height() / density, 1f)
            assertTrue(
                "The reserved editor displays the loading fill",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice): Boolean {
                            val frame = takeScreenshot()
                            val pixels =
                                if (frame.config == Bitmap.Config.HARDWARE) {
                                    checkNotNull(frame.copy(Bitmap.Config.ARGB_8888, false))
                                } else frame
                            return try {
                                pixels.getPixel(placeholder.centerX(), placeholder.centerY()) !=
                                    pixels.getPixel(placeholder.left - 4, placeholder.centerY())
                            } finally {
                                if (pixels !== frame) pixels.recycle()
                                frame.recycle()
                            }
                        }
                    },
                    5_000,
                ) == true,
            )
            ScreenshotCapture.capture("01-cold-loading.png")
            held.countDown()
            assertEquals(initialText, editor(expectedText = initialText).text)
            click(R.string.settings_cancel)
            reveal(app.getString(R.string.appearance))

            fixture.beforeRead = {
                refreshEntered.countDown()
                refreshHeld.await()
            }
            click(R.string.instructions_title)
            assertTrue(refreshEntered.await(10, TimeUnit.SECONDS))
            assertEquals(initialText, editor(expectedText = initialText).text)
            assertTrue(model.uiState.value.canEdit)
            ScreenshotCapture.capture("02-warm-refresh.png")

            val localText = "## 回复偏好\n先用简短的段落说明重点，再列出待确认事项。"
            val latestText = "## 回复偏好\n先列出下一步，再说明原因。"
            editor().text = localText
            control(R.string.instructions_save)
            fixture.externalEdit(latestText)
            refreshHeld.countDown()
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice) =
                            model.uiState.value.let { !it.busy && it.saved?.content == latestText }
                    },
                    10_000,
                ) == true,
            )
            assertEquals(localText, editor().text)
            control(R.string.instructions_save)
            assertEquals(0, fixture.requests.count { it.method == "PUT" })
            ScreenshotCapture.capture("03-edit-after-background-update.png")

            click(R.string.settings_cancel)
            reveal(app.getString(R.string.instructions_unsaved))
            ScreenshotCapture.capture("04-discard-confirmation.png")
            device.confirmInstructionsDiscard(app)
            reveal(app.getString(R.string.appearance))
            click(R.string.instructions_title)
            assertEquals(latestText, editor(expectedText = latestText).text)
            reveal(app.getString(R.string.instructions_save))
            assertFalse(model.uiState.value.canSave)
            ScreenshotCapture.capture("05-latest-after-discard.png")

            val finalText = "## 回复偏好\n先把结论说清楚，最后列出待办事项。"
            editor().text = finalText
            val savePosition = actionPosition(control(R.string.instructions_save))
            val cancelPosition = actionPosition(control(R.string.settings_cancel))
            click(R.string.instructions_save)
            reveal(app.getString(R.string.settings_saving))
            assertEquals(savePosition, actionPosition(text(app.getString(R.string.settings_saving))))
            assertEquals(cancelPosition, actionPosition(text(app.getString(R.string.settings_cancel))))
            assertEquals(InstructionsPhase.Saving, model.uiState.value.phase)
            assertFalse(model.uiState.value.canSave)
            assertEquals(finalText, editor().text)
            ScreenshotCapture.capture("06-saving.png")
            saveReply.countDown()
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice) =
                            model.uiState.value.let { !it.busy && it.saved?.content == finalText }
                    },
                    10_000,
                ) == true,
            )
            reveal(app.getString(R.string.appearance))
            assertEquals(finalText, fixture.saved.content)
            assertEquals(1, fixture.requests.count { it.method == "PUT" })
            click(R.string.instructions_title)
            assertEquals(finalText, editor(expectedText = finalText).text)
            val pendingText = "## 回复偏好\n先说明结论，再列出需要确认的事项。"
            fixture.rejectSave = true
            editor().text = pendingText
            click(R.string.instructions_save)
            reveal(app.getString(R.string.instructions_save_rejected))
            assertTrue(model.uiState.value.saveRejected)
            assertEquals(pendingText, editor().text)
            ScreenshotCapture.capture("08-save-rejected.png")

            fixture.rejectSave = false
            fixture.disconnectSave = true
            fixture.rejectRead = true
            click(R.string.instructions_save)
            reveal(app.getString(R.string.instructions_uncertain))
            assertEquals(InstructionsPhase.Uncertain, model.uiState.value.phase)
            val checkLabel = app.getString(R.string.instructions_refresh)
            reveal(checkLabel)
            device.waitForIdle()
            val checkPosition = actionPosition(text(checkLabel))
            val editorBounds = editor().visibleBounds
            val putRequests = fixture.requests.count { it.method == "PUT" }
            fixture.rejectRead = false
            fixture.beforeRead = {
                checkEntered.countDown()
                checkReply.await()
            }
            // The Compose regression drives the control. Hold the same read here for capture.
            scenario.onActivity { model.refresh() }
            assertTrue("The check performs a read", checkEntered.await(10, TimeUnit.SECONDS))
            device.waitForIdle()
            assertEquals(InstructionsPhase.Loading, model.uiState.value.phase)
            assertEquals(checkPosition, actionPosition(text(checkLabel)))
            assertEquals(editorBounds, editor().visibleBounds)
            assertEquals(pendingText, editor().text)
            assertEquals(putRequests, fixture.requests.count { it.method == "PUT" })
            ScreenshotCapture.capture("09-checking-saved-version.png")
            checkReply.countDown()
            reveal(app.getString(R.string.appearance))
            assertEquals(pendingText, fixture.saved.content)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)

            val originalSize = device.executeShellCommand("wm size")
            val originalDensity = device.executeShellCommand("wm density")
            check(originalSize.contains("Physical size:"))
            check(originalDensity.contains("Physical density:"))
            val size = Regex("Override size: (\\d+x\\d+)").find(originalSize)?.groupValues?.get(1)
            val overrideDensity =
                Regex("Override density: (\\d+)").find(originalDensity)?.groupValues?.get(1)
            restoreSize = "wm size ${size ?: "reset"}"
            restoreDensity = "wm density ${overrideDensity ?: "reset"}"
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 820x440")
            assertTrue(
                "Short window was applied",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice) =
                            device.displayWidth == 820 &&
                                device.displayHeight == 440 &&
                                app.resources.configuration.densityDpi == 160
                    },
                    10_000,
                ) == true,
            )
            openInstructions()
            assertTrue("Editor uses the short window width", editor().visibleBounds.width() > 640)
            assertEquals(pendingText, editor(expectedText = pendingText).text)
            editor().click()
            awaitIme(true)
            editor().text = "## 回复偏好\n短窗口中继续编辑。"
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(false)
            reveal(app.getString(R.string.settings_cancel))
            control(R.string.instructions_save)
            ScreenshotCapture.capture("07-short-window-editor.png")
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("native-instructions-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            held.countDown()
            refreshHeld.countDown()
            saveReply.countDown()
            checkReply.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { editorJob?.join() } } },
                    { restoreSize?.let(device::executeShellCommand) },
                    { restoreDensity?.let(device::executeShellCommand) },
                    { runBlocking { drafts.close() } },
                    { fixture.close() },
                    { cachedChats.restore() },
                    { app.restoreApiPreferences(originalPreferences) },
                    { localeManager.applicationLocales = originalLocale },
                    {
                        app.instructionsService = originalService
                        app.instructionsStore = originalStore
                    },
                    { authentication.state.value = originalAuthentication },
                    { check(directory.deleteRecursively()) },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
