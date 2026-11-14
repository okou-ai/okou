package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.instructions.PersonalInstructionsDraftStore
import android.view.KeyEvent
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
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
        fixture.beforeRead = { held.await() }
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
                if (!device.hasObject(target)) {
                    val scroll =
                        UiScrollable(UiSelector().packageName(app.packageName).scrollable(true))
                            .setAsVerticalList()
                    // Compose can move without the legacy SDK receiving its scroll-event receipt.
                    // Observe the actual Settings content instead of treating that receipt as an
                    // end.
                    for (step in 0 until 8) {
                        if (
                            device.hasObject(
                                By.pkg(app.packageName).text(app.getString(R.string.appearance))
                            )
                        )
                            break
                        scroll.scrollBackward()
                    }
                    for (step in 0 until 8) {
                        if (device.hasObject(target)) break
                        scroll.scrollForward()
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
                device.findObject(UiSelector().packageName(app.packageName).text(label)).click()
            }
            fun editor() =
                checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText")),
                        10_000,
                    )
                )
            fun awaitIme(visible: Boolean) {
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(unused: UiDevice): Boolean {
                                var actual = false
                                checkNotNull(scenario).onActivity {
                                    actual =
                                        ViewCompat.getRootWindowInsets(it.window.decorView)
                                            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                                }
                                return actual == visible
                            }
                        },
                        10_000,
                    ) == true
                )
            }
            text(app.getString(R.string.chat_list_title))
            device
                .findObject(
                    UiSelector()
                        .packageName(app.packageName)
                        .description(app.getString(R.string.settings))
                )
                .click()
            text(app.getString(R.string.appearance))
            reveal(app.getString(R.string.instructions_section))
            reveal(app.getString(R.string.instructions_loading))
            scenario.onActivity {
                editorJob =
                    checkNotNull(
                            ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        )
                        .instructions
                        .viewModelScope
                        .coroutineContext[Job]
            }
            held.countDown()
            reveal(app.getString(R.string.instructions_current))
            editor().click()
            awaitIme(true)
            editor().text = "Native **instructions** 👋"
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_ENTER))
            assertTrue(editor().text.contains('\n'))
            assertEquals(0, fixture.requests.count { it.method == "PUT" })
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            awaitIme(false)
            reveal(app.getString(R.string.instructions_section))
            scenario.recreate()
            reveal(app.getString(R.string.instructions_unsaved))
            assertTrue(editor().text.contains("Native **instructions** 👋"))
            click(R.string.instructions_save)
            reveal(app.getString(R.string.instructions_current))
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
            editor().text = "Keep this local draft"
            fixture.externalEdit("Changed on Web")
            click(R.string.instructions_refresh)
            reveal(app.getString(R.string.instructions_conflict))
            assertEquals("Keep this local draft", editor().text)
            assertEquals(1, fixture.requests.count { it.method == "PUT" })
            click(R.string.instructions_reload)
            reveal(app.getString(R.string.instructions_current))
            assertEquals("Changed on Web", editor().text)
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
