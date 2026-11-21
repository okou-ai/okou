package ai.okou.android

import ai.okou.android.auth.SessionModel
import android.os.SystemClock
import android.util.Log
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
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class NativeChatListTest {
    @Test
    fun cachedUnreadFilterOpensBeforeIndicatorsAndRemainsUsableAfterFailure() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val previous = app.chatService
        val savedPreferences = app.snapshotApiPreferences()
        val directory = app.noBackupFilesDir.resolve("chat-list")
        val savedCache = ChatCacheSnapshot(directory, app.chatCache)
        fun unreadFiles() =
            directory
                .listFiles { file -> file.name.endsWith("-unread.json") }
                .orEmpty()
                .associate { it.name to it.readText() }
        val originalUnread = unreadFiles()
        val fixture = ChatListApiFixture()
        val requested = CountDownLatch(1)
        val release = CountDownLatch(1)
        val fail = AtomicBoolean(true)
        val jobs = mutableListOf<Job>()
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        app.chatService = fixture.service
        fun text(value: String) =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(value)), 10_000)
            ) {
                "Missing $value"
            }
        fun launch() {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            device.awaitChatList(app)
            checkNotNull(scenario).onActivity { activity ->
                val chats =
                    checkNotNull(
                            ViewModelProvider(activity)[SessionModel::class.java]
                                .uiState
                                .value
                                .ready
                        )
                        .chats
                jobs += checkNotNull(chats.viewModelScope.coroutineContext[Job])
            }
        }
        try {
            launch()
            text("Project chat")
            assertTrue(
                device.wait(
                    object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) = unreadFiles() != originalUnread
                    },
                    10_000,
                )
            )
            checkNotNull(scenario).close()
            runBlocking { withTimeout(10_000) { jobs.last().join() } }

            fixture.indicators = {
                requested.countDown()
                release.await()
                if (fail.get()) MockResponse().setResponseCode(503)
                else jsonResponse("""{"agents":{},"threads":{},"unreadAt":{}}""")
            }
            val launchedAt = SystemClock.elapsedRealtime()
            launch()
            checkNotNull(
                    device.wait(
                        Until.findObject(
                            By.pkg(app.packageName).desc(app.getString(R.string.chat_filter))
                        ),
                        10_000,
                    )
                )
                .click()
            val unread = app.getString(R.string.chat_unread)
            text(unread).click()
            val subtitle = app.getString(R.string.chat_filter_subtitle, unread)
            assertTrue(
                device.wait(Until.hasObject(By.pkg(app.packageName).textContains(subtitle)), 10_000)
            )
            text("Project chat")
            Log.i(
                "OkouNativeUnread",
                "launch-to-usable-unread=${SystemClock.elapsedRealtime() - launchedAt}ms chats=2 projects=1",
            )
            assertTrue(requested.await(10, TimeUnit.SECONDS))
            assertTrue(!device.hasObject(By.pkg(app.packageName).text("Personal chat")))

            release.countDown()
            text(app.getString(R.string.chat_refresh_failed))
            text("Project chat")
            fail.set(false)
            text(app.getString(R.string.retry)).click()
            text(app.getString(R.string.chat_empty))
        } catch (error: Throwable) {
            failures.add(error)
            try {
                takeScreenshot().writeToTestStorage("native-cached-unread-failure.png")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            release.countDown()
            for (cleanup in
                listOf<() -> Unit>(
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
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
                // Back can leave the conversation scrollable visible briefly. Wait for Chats.
                device.awaitChatList(app)
                val target = chatListRegion(app).hasDescendant(By.pkg(app.packageName).text(value))
                if (!device.hasObject(target)) {
                    val list =
                        UiScrollable(
                                UiSelector()
                                    .packageName(app.packageName)
                                    .description(app.getString(R.string.chat_list_title))
                                    .scrollable(true)
                            )
                            .setAsVerticalList()
                    if (list.exists()) list.scrollIntoView(UiSelector().text(value))
                }
                assertTrue(
                    "Expected $value in the chat list",
                    device.wait(Until.hasObject(target), 10_000),
                )
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

            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            revealText("Personal chat")
            clickText("Personal chat")
            text("Hello history")
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
            assertTrue(device.wait(Until.gone(By.text("Hello history")), 10_000))
            revealText("Project chat")
            val historyRows = fixture.historyRows
            val releaseHistory = CountDownLatch(1)
            fixture.historyRows = { request ->
                if (request.requestUrl?.pathSegments?.getOrNull(2) == CHAT_IN_PROJECT)
                    releaseHistory.await()
                historyRows(request)
            }
            try {
                val tappedAt = SystemClock.elapsedRealtime()
                clickText("Project chat")
                text("Hello history")
                Log.i(
                    "OkouNativeHistory",
                    "warm revisit tap-to-first-message=${SystemClock.elapsedRealtime() - tappedAt}ms",
                )
            } finally {
                releaseHistory.countDown()
                fixture.historyRows = historyRows
            }

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
