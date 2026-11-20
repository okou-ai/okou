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
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
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
                checkNotNull(
                    device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
                )
            fun click(selector: UiSelector) {
                // Resolve at action time. The SDK return acknowledges accessibility events;
                // verify Compose's actual application outcomes below instead.
                device.findObject(selector.packageName(app.packageName)).click()
            }
            fun clickText(value: String) = click(UiSelector().text(value))
            fun revealText(value: String) {
                val target = By.pkg(app.packageName).text(value)
                val scrollable = By.pkg(app.packageName).scrollable(true)
                assertTrue(
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) =
                                device.hasObject(target) || device.hasObject(scrollable)
                        },
                        10_000,
                    )
                )
                // The whole list can fit after collapse; only scroll when it is necessary.
                val container = device.findObject(scrollable)
                if (!device.hasObject(target) && container != null) {
                    val visible =
                        object : Condition<UiObject2, Boolean> {
                            // Resolve virtual descendants from the current window after scrolls.
                            override fun apply(container: UiObject2) = device.hasObject(target)
                        }
                    if (!container.scrollUntil(Direction.UP, visible)) {
                        container.scrollUntil(Direction.DOWN, visible)
                    }
                }
                // A scroll result is not a receipt for Compose's eventual visible outcome.
                text(value)
            }
            device.awaitChatList(app)
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
            assertNotNull(
                device.wait(Until.findObject(By.desc(app.getString(R.string.chat_loading))), 10_000)
            )
            click(UiSelector().description(app.getString(R.string.settings)))
            text(app.getString(R.string.appearance))
            gate.countDown()
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            device.awaitChatList(app)
            revealText("Project chat")
            scenario.recreate()
            revealText("Project chat")
            clickText("Project chat")
            text(app.getString(R.string.history_completed))
            text("Research")
            assertTrue(
                UiScrollable(UiSelector().scrollable(true))
                    .setAsVerticalList()
                    .scrollIntoView(UiSelector().textContains("Native history"))
            )
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            click(UiSelector().description(app.getString(R.string.settings)))
            text(app.getString(R.string.appearance))
            scenario.recreate()
            text(app.getString(R.string.appearance))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertNotNull(device.wait(Until.findObject(By.textContains("Native history")), 10_000))
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.textContains("Native history")), 10_000))
            revealText("Research")
            clickText("Research")
            assertTrue(device.wait(Until.gone(By.text("Project chat")), 10_000))
            clickText("Research")
            revealText("Project chat")
            clickText("Project chat")
            text(app.getString(R.string.history_completed))
            click(UiSelector().description(app.getString(R.string.back)))
            assertTrue(device.wait(Until.gone(By.textContains("Native history")), 10_000))
            text("Project chat")
            clickText("Project chat")
            text(app.getString(R.string.history_completed))

            // Resize the actual emulator display around the open destination.
            val size = device.executeShellCommand("wm size")
            val density = device.executeShellCommand("wm density")
            check(size.contains("Physical size:") && density.contains("Physical density:"))
            val originalSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
            val originalDensity =
                Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
            try {
                device.executeShellCommand("wm size 1000x1000")
                device.executeShellCommand("wm density 160")
                val listTitle = device.awaitChatList(app)
                val conversation = text(app.getString(R.string.history_completed))
                assertTrue(listTitle.visibleBounds.right < conversation.visibleBounds.left)
                val toolbarBack = By.pkg(app.packageName).desc(app.getString(R.string.back))
                assertTrue(device.wait(Until.gone(toolbarBack), 10_000))
                val filter = app.getString(R.string.chat_filter)
                val archived = app.getString(R.string.chat_archived)
                val inbox = By.pkg(app.packageName).text(app.getString(R.string.chat_inbox))
                click(UiSelector().description(filter))
                text(app.getString(R.string.chat_inbox))
                instrumentation.setInTouchMode(false)
                assertTrue(device.pressBack())
                assertTrue(device.wait(Until.gone(inbox), 10_000))
                device.awaitKeyboardFocus(By.pkg(app.packageName).desc(filter))
                assertTrue(device.pressDPadCenter())
                text(app.getString(R.string.chat_inbox))
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_MOVE_END))
                device.awaitKeyboardFocus(
                    By.pkg(app.packageName).text(app.getString(R.string.chat_muted))
                )
                assertTrue(device.pressDPadUp())
                device.awaitKeyboardFocus(By.pkg(app.packageName).text(archived))
                assertTrue(device.pressDPadCenter())
                text(app.getString(R.string.chat_empty))
                device.awaitKeyboardFocus(By.pkg(app.packageName).desc(filter))
                val subtitle = app.getString(R.string.chat_filter_subtitle, archived)
                assertTrue(
                    device.wait(
                        Until.hasObject(By.pkg(app.packageName).textContains(subtitle)),
                        10_000,
                    )
                )
                text(app.getString(R.string.history_completed))
                assertTrue(device.pressDPadCenter())
                clickText(app.getString(R.string.chat_inbox))
                revealText("Project chat")
                click(UiSelector().description(app.getString(R.string.settings)))
                text(app.getString(R.string.appearance))
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                device.awaitChatList(app)
                text(app.getString(R.string.history_completed))
            } finally {
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
            assertTrue(device.wait(Until.gone(chatListRegion(app)), 10_000))
            text(app.getString(R.string.history_completed))
            click(UiSelector().description(app.getString(R.string.back)))
            revealText("Project chat")
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
                    { instrumentation.resetInTouchMode() },
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
