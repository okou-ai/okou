package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.rowEvent
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesBatchFailureAndRestoredUndo() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedService = app.chatService
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val savedLocales = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(locales) },
        )
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val personal = "Android 设计讨论"
        val project = "产品研究"
        val pendingRead = AtomicBoolean(true)
        val rejectAll = AtomicBoolean(true)
        val events = CopyOnWriteArrayList<Pair<Long, String>>().apply {
            add(17L to chatEventWire(title = personal))
            add(23L to chatEventWire(
                id = "77777777-7777-4777-8777-777777777777",
                seq = 23,
                thread = CHAT_IN_PROJECT,
                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                title = "访谈整理",
            ))
        }
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
            val tail = events.filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse("""{"events":[$tail],"hasMore":false}""")
        }
        fixture.projects = {
            jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"$project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""")
        }
        fixture.indicators = {
            val personalStatus = if (pendingRead.get()) "\"$CHAT_PERSONAL\":\"unread\"," else ""
            val personalMarker = if (pendingRead.get()) "\"$CHAT_PERSONAL\":\"$CHAT_DATE\"," else ""
            jsonResponse("""{"threads":{$personalStatus"$CHAT_IN_PROJECT":"unread"},"unreadAt":{$personalMarker"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""")
        }
        fixture.commandResponse = { request ->
            when (request.requestUrl?.encodedPath) {
                "/api/chat-threads/$CHAT_PERSONAL/archive" -> {
                    events.add(24L to request.rowEvent(24, CHAT_PERSONAL, "archived"))
                    MockResponse().setResponseCode(204)
                }
                "/api/chat-threads/$CHAT_PERSONAL/mark-read" -> {
                    if (rejectAll.get()) MockResponse().setResponseCode(409)
                    else {
                        pendingRead.set(false)
                        jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                    }
                }
                "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" -> MockResponse().setResponseCode(409)
                else -> null
            }
        }
        fun text(id: Int) = By.pkg(app.packageName).text(labels.getString(id))
        fun markAll() {
            device.await(By.desc(labels.getString(R.string.chat_filter))).click()
            device.await(text(R.string.chat_mark_all_read)).click()
        }
        val size = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val density = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        try {
            app.chatService = fixture.service
            app.connectivity.value = true
            app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
            auth.state.value = testAuthenticationState(user = "chat-feedback-${UUID.randomUUID()}")
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("wm density 160")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(labels)
                device.await(By.text(personal)).longClick()
                device.await(text(R.string.chat_archive)).click()
                val undo = text(R.string.chat_undo)
                device.await(undo)
                markAll()
                device.await(text(R.string.chat_mark_all_read_failed))
                check(device.wait(Until.gone(undo), 2_000L))
                ScreenshotCapture.capture("batch-read-failed.png")

                device.await(undo)
                check(!device.hasObject(text(R.string.chat_mark_all_read_failed)))
                ScreenshotCapture.capture("undo-restored.png")

                rejectAll.set(false)
                markAll()
                device.await(By.text(labels.getString(R.string.chat_mark_all_read_partial_failed, 1, 1)))
                ScreenshotCapture.capture("batch-read-partial.png")
            }
        } finally {
            fixture.close()
            savedCache.restore()
            app.restoreApiPreferences(savedPreferences)
            app.initialPreferences = savedInitialPreferences
            app.chatService = savedService
            app.connectivity.value = savedOnline
            auth.state.value = savedAuth
            instrumentation.runOnMainSync { localeManager.applicationLocales = savedLocales }
            device.executeShellCommand("wm size ${size ?: "reset"}")
            device.executeShellCommand("wm density ${density ?: "reset"}")
        }
    }

    private fun UiDevice.await(selector: BySelector) =
        checkNotNull(wait(Until.findObject(selector), 10_000L)) { "Missing $selector" }
}
