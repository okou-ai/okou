package ai.okou.android

import ai.okou.android.auth.SessionModel
import ai.okou.android.chat.ComposerJournalStore
import ai.okou.android.chat.ComposerTarget
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
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeTextSendTest {
    @Test
    fun newAndExistingTextKeepNativeImeBackRecreationAndCanonicalAcceptance() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val oldAuth = authentication.state.value
        val oldChats = app.chatService
        val oldComposer = app.composerService
        val oldJournal = app.journalStore
        val oldPreferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val directory =
            Files.createTempDirectory(app.cacheDir.toPath(), "text-send-native-").toFile()
        val journal = ComposerJournalStore(app, directory)
        val fixture = ComposerApiFixture()
        val held = CountDownLatch(1)
        fixture.beforeContextReturn = { held.await() }
        app.chatService = fixture.service
        app.composerService = fixture.service
        app.journalStore = journal
        authentication.state.value = testAuthenticationState()
        val device = UiDevice.getInstance(instrumentation)
        var scenario: ActivityScenario<MainActivity>? = null
        var composerJob: Job? = null
        var listJob: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
                )
            fun click(id: Int) {
                device
                    .findObject(UiSelector().packageName(app.packageName).text(app.getString(id)))
                    .click()
            }
            fun editor() =
                checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
                        ),
                        10_000,
                    )
                )
            fun ime(visible: Boolean) {
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                var current = false
                                checkNotNull(scenario).onActivity {
                                    current =
                                        ViewCompat.getRootWindowInsets(it.window.decorView)
                                            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                                }
                                return current == visible
                            }
                        },
                        10_000,
                    )
                )
            }
            text(app.getString(R.string.chat_list_title))
            click(R.string.composer_new)
            text(app.getString(R.string.composer_target_loading))
            scenario.onActivity {
                val ready =
                    checkNotNull(
                        ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                    )
                composerJob = ready.composer.viewModelScope.coroutineContext[Job]
                listJob = ready.chats.viewModelScope.coroutineContext[Job]
            }
            editor().click()
            editor().text = "Native first message\n你好"
            ime(true)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            ime(false)
            assertTrue(editor().text.contains("Native first message"))
            scenario.recreate()
            assertTrue(editor().text.contains("Native first message"))
            held.countDown()
            fun readyToSend(target: ComposerTarget) {
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice): Boolean {
                                var ready = false
                                checkNotNull(scenario).onActivity {
                                    ready =
                                        ViewModelProvider(it)[SessionModel::class.java]
                                            .uiState
                                            .value
                                            .ready
                                            ?.composer
                                            ?.uiState
                                            ?.value
                                            ?.canSend(target) == true
                                }
                                return ready &&
                                    device
                                        .findObject(
                                            By.pkg(app.packageName)
                                                .text(app.getString(R.string.composer_send))
                                        )
                                        ?.isEnabled == true
                            }
                        },
                        10_000,
                    )
                )
            }
            readyToSend(ComposerTarget())
            click(R.string.composer_send)
            text("New conversation")
            assertEquals(1, fixture.inputs.size)
            editor().click()
            editor().text = "Native follow-up"
            ime(true)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            ime(false)
            readyToSend(
                ComposerTarget(
                    checkNotNull(fixture.created.single()["clientThreadId"]).jsonPrimitive.content,
                    CHAT_AGENT,
                )
            )
            click(R.string.composer_send)
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = fixture.inputs.size == 2
                    },
                    10_000,
                )
            )
            text(app.getString(R.string.composer_accepted))
            assertEquals("", editor().text)
            assertEquals(1, fixture.created.size)
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            text(app.getString(R.string.chat_list_title))
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("native-text-send-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            held.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    {
                        runBlocking {
                            withTimeout(10_000) {
                                composerJob?.join()
                                listJob?.join()
                            }
                        }
                    },
                    { runBlocking { journal.close() } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(oldPreferences) },
                    {
                        app.chatService = oldChats
                        app.composerService = oldComposer
                        app.journalStore = oldJournal
                    },
                    { authentication.state.value = oldAuth },
                    { check(directory.deleteRecursively()) },
                )) try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
