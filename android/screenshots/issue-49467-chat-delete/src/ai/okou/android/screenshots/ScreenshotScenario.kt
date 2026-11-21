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
import java.util.concurrent.CountDownLatch
import java.util.UUID
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
    fun confirmsAndDeletesThroughTheNativeChatList() {
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
        val release = CountDownLatch(1)
        val tail = CopyOnWriteArrayList<Pair<Long, String>>()
        val initial = fixture.events
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong()
            if (since == null) initial(request)
            else jsonResponse("""{"events":[${tail.filter { it.first > since }.joinToString(",") { it.second }}],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            if (request.method == "DELETE" && request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL") {
                val id = checkNotNull(request.requestUrl?.queryParameter("eventId"))
                assertEquals(id, UUID.fromString(id).toString())
                assertEquals("Bearer fixture-token", request.getHeader("Authorization"))
                requests.add(id)
                release.await()
                tail.add(24L to chatEventWire(id = id, seq = 24L, kind = "deleted"))
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
                checkNotNull(row()).longClick()
                val delete = text(app.getString(R.string.chat_delete))
                val menuItem = checkNotNull(device.wait(Until.findObject(delete), 10_000))
                ScreenshotCapture.capture("delete-menu.png")
                menuItem.click()
                assertNotNull(device.wait(Until.findObject(text(app.getString(R.string.chat_delete_title))), 10_000))
                assertEquals(0, requests.size)
                ScreenshotCapture.capture("delete-confirmation.png")
                checkNotNull(device.findObject(text(app.getString(R.string.chat_delete_confirm)))).click()
                assertTrue(device.wait(Until.gone(text("Personal chat")), 10_000))
                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) = requests.size == 1
                }, 10_000))
                assertTrue(device.hasObject(text("Project chat")))
                ScreenshotCapture.capture("delete-pending.png")
                release.countDown()
                assertTrue(device.wait(object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice): Boolean {
                        var settled = false
                        scenario.onActivity {
                            val list = ViewModelProvider(it)[SessionModel::class.java].uiState.value.ready
                                ?.chats?.uiState?.value
                            settled = list?.let { state ->
                                CHAT_PERSONAL !in state.pendingRowActions &&
                                    state.threads.none { thread -> thread.id == CHAT_PERSONAL }
                            } == true
                        }
                        return settled
                    }
                }, 10_000))
            }
        } finally {
            release.countDown()
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
