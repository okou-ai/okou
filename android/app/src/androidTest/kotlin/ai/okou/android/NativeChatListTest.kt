package ai.okou.android

import ai.okou.android.auth.SessionModel
import android.view.KeyEvent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeChatListTest {
    @Test
    fun pendingTransportAllowsSettingsAndLoadedProjectsSurviveActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previous = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val gate = CountDownLatch(1)
        fixture.beforeResponse = { gate.await() }
        app.chatService = fixture.service
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            fun text(value: String) =
                checkNotNull(device.wait(Until.findObject(By.text(value)), 10_000))
            fun click(selector: UiSelector) {
                // Resolve at action time. The SDK return acknowledges accessibility events;
                // verify Compose's actual application outcomes below instead.
                device.findObject(selector.packageName(app.packageName)).click()
            }
            fun clickText(value: String) = click(UiSelector().text(value))
            fun revealText(value: String) {
                // A collapsed Project can make the entire list fit without a scrollable node.
                if (!device.hasObject(By.pkg(app.packageName).text(value))) {
                    assertTrue(
                        UiScrollable(UiSelector().packageName(app.packageName).scrollable(true))
                            .setAsVerticalList()
                            .scrollTextIntoView(value)
                    )
                }
                text(value)
            }
            text(app.getString(R.string.chat_list_title))
            scenario.onActivity { activity ->
                chatJob =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                        .viewModelScope
                        .coroutineContext[Job]
            }
            text(app.getString(R.string.chat_loading))
            click(UiSelector().description(app.getString(R.string.settings)))
            text(app.getString(R.string.appearance))
            gate.countDown()
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            text(app.getString(R.string.chat_status_observed))
            revealText("Research Okou")
            scenario.recreate()
            revealText("Research Okou")
            assertNotNull(device.findObject(By.text("Project chat")))
            clickText("Project chat")
            text(app.getString(R.string.history_completed))
            assertTrue(
                UiScrollable(UiSelector().scrollable(true))
                    .setAsVerticalList()
                    .scrollIntoView(UiSelector().textContains("Native history"))
            )
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            clickText(app.getString(R.string.history_sidebar))
            assertTrue(
                device.wait(Until.gone(By.text(app.getString(R.string.history_sidebar))), 10_000)
            )
            revealText("Project chat")
            clickText("Research")
            assertTrue(device.wait(Until.gone(By.text("Project chat")), 10_000))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            clickText(app.getString(R.string.history_sidebar))
            assertTrue(
                device.wait(Until.gone(By.text(app.getString(R.string.history_sidebar))), 10_000)
            )
            revealText("Research")
            clickText("Research")
            revealText("Project chat")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            text("Project chat")
        } catch (error: Throwable) {
            failures.add(error)
            try {
                takeScreenshot().writeToTestStorage("native-chat-list-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            gate.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                    { fixture.close() },
                    { savedCache.restore() },
                    { app.restoreApiPreferences(savedPreferences) },
                    { app.chatService = previous },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
