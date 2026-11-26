package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.confirmInstructionsDiscard
import ai.okou.android.instructions.InstructionsPhase
import ai.okou.android.instructions.InstructionsRead
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import ai.okou.android.instructions.PersonalInstructionsModel
import ai.okou.android.instructions.PersonalInstructionsState
import ai.okou.android.openChatListSettings
import ai.okou.android.resolvePalette
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.workflows.WorkflowModel
import android.graphics.Bitmap
import android.graphics.Color
import android.view.KeyEvent
import android.view.WindowInsets
import android.view.accessibility.AccessibilityWindowInfo
import android.view.inspector.WindowInspector
import androidx.lifecycle.ViewModelProvider
import androidx.compose.ui.graphics.toArgb
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
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
    fun workflowEditorAndNativeTimePicker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val originalAuthentication = authentication.state.value
        val originalPreferences = app.snapshotApiPreferences()
        val originalChatService = app.chatService
        val originalWorkflows = app.workflows
        val localeManager = checkNotNull(app.getSystemService(android.app.LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val cachedChats = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val device = UiDevice.getInstance(instrumentation)
        val fixture = WorkflowApiFixture(chinese = true)
        try {
            app.restoreApiPreferences(
                mapOf(
                    Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                        ),
                ),
            )
            app.chatService = fixture.service
            app.workflows = fixture.service
            authentication.state.value = testAuthenticationState()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun visible(selector: BySelector) =
                    checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                        "Missing workflow control: $selector"
                    }
                fun text(label: String) = visible(By.pkg(app.packageName).text(label))
                fun control(id: Int) = visible(By.pkg(app.packageName).text(app.getString(id)).enabled(true))
                fun action(id: Int) = control(id).click()
                fun nameField() =
                    By.pkg(app.packageName).clazz("android.widget.EditText")
                        .desc(app.getString(R.string.workflow_name))

                device.awaitChatList(app)
                visible(By.pkg(app.packageName).desc(app.getString(R.string.workspace_workflows))).click()
                text(fixture.releaseTitle).click()
                action(R.string.workflow_edit_instructions)
                visible(nameField())
                ScreenshotCapture.capture("15-workflow-editor.png")

                lateinit var model: WorkflowModel
                scenario.onActivity { activity ->
                    val session = ViewModelProvider(activity)[SessionModel::class.java]
                    model = checkNotNull(session.uiState.value.ready?.workflows)
                }
                try {
                    val draftName = "发布前核对负责人和时间"
                    val latestInstruction = "网页版已更新发布清单，请核对最新内容。"
                    val submitted = CountDownLatch(1)
                    fixture.beforeInstructionSave = {
                        fixture.instruction = latestInstruction
                        submitted.countDown()
                    }
                    fixture.instructionSaveConflict = true
                    visible(nameField()).text = draftName
                    visible(nameField().text(draftName))
                    action(R.string.workflow_save)
                    assertTrue("The enabled Save reaches the workflow PATCH", submitted.await(10, TimeUnit.SECONDS))
                    assertTrue(
                        "The editor reads the confirmed workflow after the server rejects the save",
                        device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(unused: UiDevice): Boolean =
                                    model.state.value.detail?.instruction == latestInstruction
                            },
                            10_000,
                        ) == true,
                    )
                    assertEquals(draftName, visible(nameField()).text)
                    val conflict = text(app.getString(R.string.workflow_write_conflict))
                    val save = control(R.string.workflow_save)
                    assertTrue(conflict.visibleBounds.bottom <= save.visibleBounds.top)
                    ScreenshotCapture.capture("18-workflow-save-conflict.png")
                } catch (failure: Throwable) {
                    try {
                        takeScreenshot().writeToTestStorage("native-workflow-conflict-failure.png")
                    } catch (diagnostic: Throwable) {
                        failure.addSuppressed(diagnostic)
                    }
                    throw failure
                }

                action(R.string.workflow_cancel)
                action(R.string.workflow_discard)
                action(R.string.workflow_automations)
                action(R.string.workflow_add_automation)
                val timeSelector = By.pkg(app.packageName).desc(app.getString(R.string.workflow_time))
                visible(timeSelector)
                ScreenshotCapture.capture("16-automation-editor.png")
                visible(timeSelector).click()
                visible(By.res("android:id/button1"))
                ScreenshotCapture.capture("17-system-time-picker.png")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                visible(timeSelector)
            }
        } finally {
            fixture.close()
            cachedChats.restore()
            app.chatService = originalChatService
            app.workflows = originalWorkflows
            app.restoreApiPreferences(originalPreferences)
            localeManager.applicationLocales = originalLocale
            authentication.state.value = originalAuthentication
        }
    }

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
            fun assertActionPosition(expected: Pair<Int, Int>, node: UiObject2) {
                val actual = actionPosition(node)
                // Caption widths can round their integer center one pixel differently.
                assertTrue("Action moved from $expected to $actual", abs(expected.first - actual.first) <= 1)
                assertEquals(expected.second, actual.second)
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
            fun awaitState(message: String, condition: (PersonalInstructionsState) -> Boolean) {
                assertTrue(
                    message,
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean =
                                condition(model.uiState.value)
                        },
                        10_000,
                    ) == true,
                )
            }
            fun captureSettingColors(name: String, dark: Boolean) {
                val scheme = resolvePalette(UserPreferencesColorTheme.DEFAULT, dark)
                val expected = scheme.surface.toArgb()
                assertTrue(
                    "Settings surface has the selected theme: $name",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean {
                                val frame = takeScreenshot()
                                val pixels =
                                    if (frame.config == Bitmap.Config.HARDWARE)
                                        checkNotNull(frame.copy(Bitmap.Config.ARGB_8888, false))
                                    else frame
                                return try {
                                    val painted = pixels.getPixel(6, frame.height / 2) == expected
                                    if (painted) ScreenshotCapture.capture(name, frame)
                                    painted
                                } finally {
                                    if (pixels !== frame) pixels.recycle()
                                    if (!frame.isRecycled) frame.recycle()
                                }
                            }
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
            val saveLabel = app.getString(R.string.instructions_save)
            val cancelLabel = app.getString(R.string.settings_cancel)
            val initialSave = actionPosition(text(saveLabel))
            val initialCancel = actionPosition(text(cancelLabel))
            fixture.rejectRead = true
            held.countDown()
            awaitState("Three attempts end in a cold read failure") {
                !it.busy && it.read == InstructionsRead.Failed
            }
            assertEquals(3, fixture.requests.count { it.method == "GET" })
            text(app.getString(R.string.instructions_load_failed))
            assertActionPosition(initialSave, text(saveLabel))
            assertActionPosition(initialCancel, text(cancelLabel))
            ScreenshotCapture.capture("10-cold-read-failed.png")
            fixture.rejectRead = false
            scenario.onActivity { model.refresh() }
            assertEquals(initialText, editor(expectedText = initialText).text)
            assertActionPosition(initialSave, text(saveLabel))
            assertActionPosition(initialCancel, text(cancelLabel))
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
            val beforeFailureEditor = editor().visibleBounds
            val saveButton = control(R.string.instructions_save)
            val beforeFailureSave = actionPosition(saveButton)
            val saveBounds = saveButton.visibleBounds
            fixture.rejectRead = true
            scenario.onActivity { model.refresh() }
            awaitState("Warm failure leaves the draft editable") {
                !it.busy && it.read == InstructionsRead.RefreshFailed && it.canSave
            }
            val snackbar =
                text(app.getString(R.string.instructions_refresh_failed)).visibleBounds
            assertTrue(
                "Refresh feedback $snackbar stays above Save $saveBounds",
                snackbar.bottom <= saveBounds.top,
            )
            assertTrue(
                "The snackbar's inverse surface is painted before capture",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice): Boolean {
                            val frame = takeScreenshot()
                            val pixels =
                                if (frame.config == Bitmap.Config.HARDWARE) {
                                    checkNotNull(frame.copy(Bitmap.Config.ARGB_8888, false))
                                } else frame
                            return try {
                                val color = pixels.getPixel(
                                    snackbar.left - (4 * density).toInt(),
                                    snackbar.centerY(),
                                )
                                val painted = Color.luminance(color) < 0.25f
                                if (painted) {
                                    ScreenshotCapture.capture("11-warm-refresh-failed.png", frame)
                                }
                                painted
                            } finally {
                                if (pixels !== frame) pixels.recycle()
                                if (!frame.isRecycled) frame.recycle()
                            }
                        }
                    },
                    3_000,
                ) == true,
            )
            val visibleEditor = editor(expectedText = finalText).visibleBounds
            // Accessibility clips visible bounds behind the transient Snackbar.
            assertEquals(beforeFailureEditor.left, visibleEditor.left)
            assertEquals(beforeFailureEditor.top, visibleEditor.top)
            assertEquals(beforeFailureEditor.right, visibleEditor.right)
            assertActionPosition(beforeFailureSave, text(saveLabel))
            fixture.rejectRead = false
            scenario.onActivity { model.refresh() }
            awaitState("Recovery clears the old read feedback") {
                !it.busy && it.read == InstructionsRead.Ready
            }
            assertTrue(device.wait(Until.gone(By.text(app.getString(R.string.instructions_refresh_failed))), 5_000))
            assertTrue(
                "The editor recovers its full visible bounds after the overlay",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice): Boolean =
                            editor(expectedText = finalText).visibleBounds == beforeFailureEditor
                    },
                    5_000,
                ) == true,
            )
            val savePosition = actionPosition(control(R.string.instructions_save))
            val cancelPosition = actionPosition(control(R.string.settings_cancel))
            click(R.string.instructions_save)
            reveal(app.getString(R.string.settings_saving))
            assertActionPosition(savePosition, text(app.getString(R.string.settings_saving)))
            assertActionPosition(cancelPosition, text(app.getString(R.string.settings_cancel)))
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
            assertTrue(text(app.getString(R.string.instructions_save_rejected)).visibleBounds.bottom <= text(saveLabel).visibleBounds.top)
            assertTrue(model.uiState.value.saveRejected)
            assertEquals(pendingText, editor().text)
            ScreenshotCapture.capture("08-save-rejected.png")

            fixture.rejectSave = false
            fixture.disconnectSave = true
            device.waitForIdle()
            val checkPosition = actionPosition(text(app.getString(R.string.instructions_save)))
            val editorBounds = editor().visibleBounds
            val putRequests = fixture.requests.count { it.method == "PUT" }
            fixture.beforeRead = {
                checkEntered.countDown()
                checkReply.await()
            }
            click(R.string.instructions_save)
            assertTrue("The check performs a read", checkEntered.await(10, TimeUnit.SECONDS))
            reveal(app.getString(R.string.instructions_checking))
            assertEquals(InstructionsPhase.Checking, model.uiState.value.phase)
            assertTrue(text(app.getString(R.string.instructions_checking)).visibleBounds.bottom <= text(saveLabel).visibleBounds.top)
            assertActionPosition(checkPosition, text(app.getString(R.string.instructions_save)))
            assertEquals(editorBounds, editor().visibleBounds)
            assertEquals(pendingText, editor().text)
            assertEquals(putRequests + 1, fixture.requests.count { it.method == "PUT" })
            ScreenshotCapture.capture("09-checking-saved-version.png")
            checkReply.countDown()
            reveal(app.getString(R.string.appearance))
            assertEquals(pendingText, fixture.saved.content)
            captureSettingColors("12-settings-light.png", dark = false)
            click(R.string.appearance)
            click(R.string.appearance_dark)
            reveal(app.getString(R.string.instructions_title))
            captureSettingColors("13-settings-dark.png", dark = true)
            click(R.string.instructions_title)
            editor(expectedText = pendingText).click()
            awaitIme(true)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(false)
            assertTrue("Instructions retains native focus below the IME", editor(expectedText = pendingText).isFocused)
            ScreenshotCapture.capture("14-instructions-dark-focused.png")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            reveal(app.getString(R.string.appearance))
            click(R.string.appearance)
            click(R.string.appearance_light)
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
            val shortText = "## 回复偏好\n短窗口中继续编辑。"
            editor().text = shortText
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(
                "The IME insets settle before capturing the full short-window editor",
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice): Boolean {
                            var bottom = -1
                            instrumentation.runOnMainSync {
                                val root = WindowInspector.getGlobalWindowViews().firstOrNull {
                                    it.hasWindowFocus() && it.rootWindowInsets != null
                                }
                                bottom = root?.rootWindowInsets?.getInsets(WindowInsets.Type.ime())?.bottom ?: -1
                            }
                            return bottom == 0 && !imeVisible()
                        }
                    },
                    10_000,
                ) == true,
            )
            reveal(app.getString(R.string.settings_cancel))
            control(R.string.instructions_save)
            assertTrue("The short-window editor is visible", editor(expectedText = shortText).visibleBounds.height() >= 100)
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
