package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.instructions.InstructionsPhase
import ai.okou.android.instructions.PersonalInstructionsDraftStore
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
class NativeInstructionsTest {
    @Test
    fun nativeEditingImeBackRecreationSaveAndExternalConflictKeepTheirOwners() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val originalAuthentication = authentication.state.value
        val originalService = app.instructionsService
        val originalStore = app.instructionsStore
        val originalPreferences = app.snapshotApiPreferences()
        val cachedChats =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "instructions-native-").toFile()
        val drafts = PersonalInstructionsDraftStore(app, directory)
        val fixture = InstructionsApiFixture()
        val held = CountDownLatch(1)
        val entered = CountDownLatch(1)
        fixture.beforeRead = {
            entered.countDown()
            held.await()
        }
        app.instructionsService = fixture.service
        app.instructionsStore = drafts
        authentication.state.value = testAuthenticationState()
        val device = UiDevice.getInstance(instrumentation)
        var scenario: ActivityScenario<MainActivity>? = null
        var editorJob: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
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
            fun click(id: Int) {
                val label = app.getString(id)
                reveal(label)
                checkNotNull(
                        device.wait(
                            Until.findObject(By.pkg(app.packageName).text(label).enabled(true)),
                            10_000,
                        )
                    )
                    .click()
            }
            fun editor(requireFocus: Boolean = false) =
                checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).clazz("android.widget.EditText").apply {
                                if (requireFocus) focused(true)
                            }
                        ),
                        10_000,
                    )
                )
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
                    ) == true
                )
            }
            device.awaitChatList(app)
            checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName)
                                .desc(app.getString(R.string.settings))
                                .enabled(true)
                        ),
                        10_000,
                    )
                )
                .click()
            text(app.getString(R.string.appearance))
            click(R.string.instructions_title)
            assertTrue(entered.await(10, TimeUnit.SECONDS))
            scenario.onActivity {
                val editor =
                    checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                        .instructions
                editorJob = editor.viewModelScope.coroutineContext[Job]
                assertEquals(InstructionsPhase.Loading, editor.uiState.value.phase)
            }
            // The host Compose test covers pending Instructions feedback. Release the actual HTTP
            // response after native first-display proof, before gestures can exhaust its deadline.
            held.countDown()
            editor().click()
            awaitIme(true)
            editor().text = "Native **instructions** 👋"
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
            assertTrue(editor().text.contains('\n'))
            assertEquals(0, fixture.requests.count { it.method == "PUT" })
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(false)
            reveal(app.getString(R.string.instructions_title))
            scenario.recreate()
            assertTrue(editor(requireFocus = true).text.contains("Native **instructions** 👋"))
            device.waitForIdle()
            assertFalse("Recreation reopened the dismissed keyboard", imeVisible())

            editor().click()
            awaitIme(true)
            scenario.recreate()
            assertTrue(editor(requireFocus = true).text.contains("Native **instructions** 👋"))
            awaitIme(true)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(false)
            click(R.string.instructions_save)
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(unused: UiDevice) =
                            fixture.saved.content.contains("Native **instructions** 👋")
                    },
                    10_000,
                ) == true
            )
            assertTrue(fixture.saved.content.contains("Native **instructions** 👋"))
            reveal(app.getString(R.string.appearance))
            click(R.string.instructions_title)
            editor().text = "Keep this local draft"
            fixture.externalEdit("Changed on Web")
            scenario.onActivity {
                checkNotNull(ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready)
                    .instructions
                    .refresh()
            }
            reveal(app.getString(R.string.instructions_conflict))
            assertEquals("Keep this local draft", editor().text)
            assertEquals(1, fixture.requests.count { it.method == "PUT" })
            click(R.string.instructions_reload)
            assertEquals("Changed on Web", editor().text)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            reveal(app.getString(R.string.appearance))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("native-instructions-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            held.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { editorJob?.join() } } },
                    { runBlocking { drafts.close() } },
                    { fixture.close() },
                    { cachedChats.restore() },
                    { app.restoreApiPreferences(originalPreferences) },
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
