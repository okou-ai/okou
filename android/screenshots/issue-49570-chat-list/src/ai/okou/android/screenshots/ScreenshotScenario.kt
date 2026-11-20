package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import android.graphics.Color
import android.graphics.Rect
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.concurrent.CountDownLatch
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
class ScreenshotScenario {
    @Test
    fun listShowsNativeLoadingRefreshAndShortPaneStates() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val savedSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val savedDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val savedFont = device.executeShellCommand("settings get system font_scale").trim()
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val gate = CountDownLatch(1)
        val failing = AtomicBoolean()
        val jobs = mutableSetOf<Job>()
        var scenario: ActivityScenario<MainActivity>? = null
        val failures = mutableListOf<Throwable>()
        fixture.beforeResponse = { gate.await() }
        val rows =
            (1..24).joinToString(",") { index ->
                val suffix = index.toString().padStart(12, '0')
                chatEventWire(
                    id = "61000000-0000-4000-8000-$suffix",
                    seq = index.toLong(),
                    thread = "62000000-0000-4000-8000-$suffix",
                    title = "Design review " + index.toString().padStart(2, '0'),
                )
            }
        fixture.events = { request ->
            if (failing.get()) MockResponse().setResponseCode(503)
            else {
                val events =
                    if (request.requestUrl?.queryParameter("sinceSeqId") == null) rows else ""
                jsonResponse("""{"events":[$events],"hasMore":false}""")
            }
        }
        app.chatService = fixture.service
        app.connectivity.value = true
        try {
            fun text(value: String) = By.pkg(app.packageName).text(value)
            fun await(description: String, timeout: Long = 10_000, check: () -> Boolean) {
                assertTrue(
                    description,
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(device: UiDevice) = check()
                        },
                        timeout,
                    ),
                )
            }
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("wm size 400x800")
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity

            fun awaitWindow(width: Int, height: Int, fontScale: Float) {
                await("The activity should receive the requested viewport and font scale") {
                    var ready = false
                    activity.onActivity {
                        val bounds = it.windowManager.currentWindowMetrics.bounds
                        val configuration = it.resources.configuration
                        ready =
                            bounds.width() == width &&
                                bounds.height() == height &&
                                configuration.densityDpi == 160 &&
                                configuration.fontScale == fontScale
                    }
                    ready
                }
            }
            fun chatOwner(block: (ai.okou.android.chat.ChatListModel) -> Unit) {
                activity.onActivity {
                    val ready = ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                    ready?.chats?.let { chats ->
                        chats.viewModelScope.coroutineContext[Job]?.let(jobs::add)
                        block(chats)
                    }
                }
            }

            val newChat = text(app.getString(R.string.composer_new))
            fun actionBounds(selector: BySelector, enabled: Boolean = true) =
                generateSequence(device.findObject(selector)) { it.parent }
                    .firstOrNull {
                        if (enabled) it.isClickable && it.isEnabled
                        else it.isClickable || it.className == "android.widget.Button"
                    }
                    ?.visibleBounds
            fun newChatBounds() = actionBounds(newChat)
            fun renderedButton(bounds: Rect?): Boolean {
                if (bounds == null || bounds.height() < 56 || bounds.width() < 48) return false
                val bitmap = takeScreenshot()
                return try {
                    val points = (bounds.left + 8 until bounds.right - 8 step 4)
                    points.count { x -> Color.red(bitmap.getPixel(x, bounds.centerY())) < 205 } >=
                        points.count() / 2
                } finally {
                    bitmap.recycle()
                }
            }

            awaitWindow(400, 800, 1f)
            val skeleton = By.pkg(app.packageName).desc(app.getString(R.string.chat_loading))
            await("The cold skeleton and bottom action should both be rendered") {
                device.hasObject(skeleton) && renderedButton(actionBounds(newChat, enabled = false))
            }
            ScreenshotCapture.capture("list-initial.png")
            gate.countDown()
            assertNotNull(device.wait(Until.findObject(text("Design review 24")), 10_000))
            await("The enabled floating New chat button should be rendered") {
                renderedButton(newChatBounds())
            }
            ScreenshotCapture.capture("list-regular.png")

            fun scrollList(towardEnd: Boolean, description: String, reached: () -> Boolean) {
                repeat(15) {
                    if (reached()) return
                    val x = device.displayWidth / 2
                    val high = maxOf(120, device.displayHeight / 4)
                    val low = device.displayHeight * 4 / 5
                    val (start, end) = if (towardEnd) low to high else high to low
                    assertTrue(device.swipe(x, start, x, end, 25))
                    device.waitForIdle(750)
                }
                assertTrue(description, reached())
            }
            val finalRow = text("Design review 01")
            scrollList(true, "The last row should be reachable above the floating action") {
                val last = actionBounds(finalRow)
                val action = newChatBounds()
                last != null &&
                    action != null &&
                    last.height() >= 50 &&
                    last.bottom + 8 <= action.top
            }
            failing.set(true)
            chatOwner { it.refreshList() }
            val refreshFailed = text(app.getString(R.string.chat_list_refresh_failed))
            await("The refresh state should appear after the background read failures", 50_000) {
                device.findObject(refreshFailed)?.visibleBounds?.height()?.let { it > 0 } == true
            }
            await("The final row should fit above both floating controls") {
                val last = actionBounds(finalRow)
                val send = newChatBounds()
                val notice = device.findObject(refreshFailed)?.visibleBounds
                last != null &&
                    send != null &&
                    notice != null &&
                    last.height() >= 50 &&
                    send.height() >= 56 &&
                    last.bottom + 8 <= minOf(send.top, notice.top) &&
                    renderedButton(send)
            }
            ScreenshotCapture.capture("list-refresh-failed.png")

            app.connectivity.value = false
            device.executeShellCommand("settings put system font_scale 2.0")
            device.executeShellCommand("wm size 320x350")
            awaitWindow(320, 350, 2f)
            chatOwner {}
            val offline = text(app.getString(R.string.chat_list_offline))
            scrollList(false, "The short list should expose the inline actions at the beginning") {
                newChatBounds()?.height()?.let { it >= 56 } == true && device.hasObject(offline)
            }
            await("The short list should render the full inline action and offline state") {
                renderedButton(newChatBounds()) &&
                    device.hasObject(offline) &&
                    !device.hasObject(refreshFailed)
            }
            ScreenshotCapture.capture("list-short-offline.png")
            scrollList(true, "The short-list actions should scroll away and expose the final row") {
                actionBounds(finalRow)?.height()?.let { it >= 50 } == true &&
                    !device.hasObject(newChat)
            }
        } catch (error: Throwable) {
            failures += error
            try {
                takeScreenshot().writeToTestStorage("list-layout-failure")
            } catch (diagnostic: Throwable) {
                error.addSuppressed(diagnostic)
            }
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { gate.countDown() },
                    { scenario?.close() },
                    { runBlocking { withTimeout(10_000) { jobs.forEach { it.join() } } } },
                    { fixture.close() },
                    { cache.restore() },
                    { app.restoreApiPreferences(preferences) },
                    {
                        app.chatService = savedService
                        app.connectivity.value = savedOnline
                    },
                    { device.executeShellCommand("wm size " + (savedSize ?: "reset")) },
                    { device.executeShellCommand("wm density " + (savedDensity ?: "reset")) },
                    {
                        if (savedFont == "null")
                            device.executeShellCommand("settings delete system font_scale")
                        else device.executeShellCommand("settings put system font_scale $savedFont")
                    },
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
