package ai.okou.android.screenshots

import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun archivesAndUndoesThroughTheNativeChatList() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val savedSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val savedDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val preferences = app.snapshotApiPreferences()
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val requests = CopyOnWriteArrayList<String>()
        val tail = CopyOnWriteArrayList<Pair<Long, String>>()
        val initial = fixture.events
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong()
            if (since == null) initial(request)
            else jsonResponse("""{"events":[${tail.filter { it.first > since }.joinToString(",") { it.second }}],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            val path = request.requestUrl?.pathSegments.orEmpty()
            val action = path.lastOrNull()
            if (request.method == "POST" && path.getOrNull(2) == CHAT_PERSONAL &&
                action in setOf("archive", "unarchive")
            ) {
                val id = checkNotNull(request.requestUrl?.queryParameter("eventId"))
                val seq = if (action == "archive") 24L else 25L
                tail.add(seq to chatEventWire(id = id, seq = seq, kind = if (action == "archive") "archived" else "unarchived"))
                requests.add(checkNotNull(action))
                MockResponse().setResponseCode(204)
            } else null
        }
        var job: Job? = null
        app.chatService = fixture.service
        app.connectivity.value = true
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 400x800")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun text(value: String) = By.pkg(app.packageName).text(value)
                fun row() = generateSequence(device.findObject(text("Personal chat"))) { it.parent }
                    .firstOrNull { it.isClickable }
                assertNotNull(device.wait(Until.findObject(text("Personal chat")), 10_000))
                scenario.onActivity {
                    job = ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                        ?.chats?.viewModelScope?.coroutineContext?.get(Job)
                }
                val bounds = checkNotNull(row()).visibleBounds
                val y = bounds.centerY().toFloat()
                val x = (bounds.right - 45).toFloat()
                val down = SystemClock.uptimeMillis()
                val finger = MotionEvent.PointerProperties().apply {
                    id = 0
                    toolType = MotionEvent.TOOL_TYPE_FINGER
                }
                fun pointer(action: Int, at: Float) {
                    val coordinates = MotionEvent.PointerCoords().also {
                        it.x = at
                        it.y = y
                        it.pressure = 1f
                        it.size = 1f
                    }
                    val event = MotionEvent.obtain(
                        down, SystemClock.uptimeMillis(), action, 1, arrayOf(finger), arrayOf(coordinates),
                        0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0,
                    )
                    try {
                        instrumentation.sendPointerSync(event)
                    } finally {
                        event.recycle()
                    }
                }
                pointer(MotionEvent.ACTION_DOWN, x)
                try {
                    pointer(MotionEvent.ACTION_MOVE, x - 55)
                    pointer(MotionEvent.ACTION_MOVE, x - 116)
                    val moved = device.wait(object : Condition<UiDevice, Boolean> {
                        override fun apply(device: UiDevice) =
                            (row()?.visibleBounds?.right ?: bounds.right) <= bounds.right - 72
                    }, 5_000)
                    if (!moved) ScreenshotCapture.capture("list-swipe-diagnostic.png")
                    assertTrue("Expected $bounds to shift left, observed ${row()?.visibleBounds}, commands $requests", moved)
                    assertTrue(requests.isEmpty())
                    ScreenshotCapture.capture("list-swipe.png")
                } finally {
                    pointer(MotionEvent.ACTION_UP, x - 116)
                }
                val undo = device.wait(Until.findObject(text(app.getString(R.string.chat_undo))), 10_000)
                assertNotNull(undo)
                assertEquals(listOf("archive"), requests.toList())
                assertTrue(!device.hasObject(text("Personal chat")))
                assertTrue(device.hasObject(text(app.getString(R.string.chat_undo_archived))))
                ScreenshotCapture.capture("list-undo.png")
                undo!!.click()
                assertNotNull(device.wait(Until.findObject(text("Personal chat")), 10_000))
                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = requests.toList() == listOf("archive", "unarchive")
                }, 10_000))
                ScreenshotCapture.capture("list-restored.png")
            }
        } finally {
            try {
                runBlocking { withTimeout(10_000) { job?.join() } }
                fixture.close()
                cache.restore()
                app.restoreApiPreferences(preferences)
            } finally {
                app.chatService = savedService
                app.connectivity.value = savedOnline
                device.executeShellCommand("wm size " + (savedSize ?: "reset"))
                device.executeShellCommand("wm density " + (savedDensity ?: "reset"))
            }
        }
    }
}
