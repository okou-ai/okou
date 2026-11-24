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
import ai.okou.android.auth.SessionModel
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
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
        val widePane = AtomicBoolean(false)
        val failListSync = AtomicBoolean(false)
        val events = CopyOnWriteArrayList<Pair<Long, String>>().apply {
            add(17L to chatEventWire(title = personal))
            listOf("本周发布计划", "产品访谈提纲", "同步客户反馈").forEachIndexed { index, title ->
                val sequence = 18L + index
                val suffix = sequence.toString().padStart(12, '0')
                add(sequence to chatEventWire(
                    id = "77777777-7777-4777-8777-$suffix",
                    seq = sequence,
                    thread = "22222222-2222-4222-8222-$suffix",
                    title = title,
                ))
            }
            add(23L to chatEventWire(
                id = "77777777-7777-4777-8777-777777777777",
                seq = 23,
                thread = CHAT_IN_PROJECT,
                extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                title = "访谈整理",
            ))
        }
        fixture.events = { request ->
            if (failListSync.get()) MockResponse().setResponseCode(503)
            else {
                val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
                val tail = events.filter { it.first > since }.joinToString(",") { it.second }
                jsonResponse("""{"events":[$tail],"hasMore":false}""")
            }
        }
        fixture.projects = {
            jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"$project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""")
        }
        fixture.indicators = {
            val personalStatus = if (pendingRead.get()) "\"$CHAT_PERSONAL\":\"unread\"," else ""
            val personalMarker = if (pendingRead.get()) "\"$CHAT_PERSONAL\":\"$CHAT_DATE\"," else ""
            jsonResponse("""{"threads":{$personalStatus"$CHAT_IN_PROJECT":"unread"},"unreadAt":{$personalMarker"$CHAT_IN_PROJECT":"$CHAT_DATE"}}""")
        }
        val latestReply = "下一步，我会把这些问题整理成优先级清单。"
        fixture.historyReply = (
            listOf("**访谈整理**", "我将访谈归纳为三个主题：首次使用、日常协作和消息提醒。") +
                List(32) { index ->
                    "访谈记录 ${index + 1}。先确认用户遇到的问题，再整理对应的操作步骤和反馈。"
                } + latestReply
            ).joinToString("\n\n")
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
                "/api/chat-threads/$CHAT_IN_PROJECT/mark-read" ->
                    if (widePane.get()) jsonResponse("""{"lastReadAt":"$CHAT_DATE"}""")
                    else MockResponse().setResponseCode(409)
                "/api/chat-threads/$CHAT_IN_PROJECT/archive" -> MockResponse().setResponseCode(400)
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
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
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

                device.await(undo)
                widePane.set(true)
                device.executeShellCommand("wm size 1180x920")
                device.await(undo)
                val projectChat = By.text("访谈整理")
                if (!device.hasObject(projectChat)) device.await(By.text(project)).click()
                device.await(projectChat).click()
                device.await(By.text(latestReply))
                val rightPaneCenter = device.displayWidth * 3 / 4
                val displayHeight = device.displayHeight
                check(device.swipe(rightPaneCenter, displayHeight / 4, rightPaneCenter, displayHeight * 3 / 4, 32))
                val jumpLabels = listOf(
                    R.string.conversation_jump_latest,
                    R.string.conversation_new_reply,
                    R.string.conversation_view_progress,
                ).joinToString("|") { Regex.escape(labels.getString(it)) }
                val readingJump = By.desc(Regex(jumpLabels).toPattern())
                device.await(readingJump)
                val chatActions = By.desc(labels.getString(R.string.chat_actions))
                device.await(chatActions)
                failListSync.set(true)
                scenario.onActivity { activity ->
                    checkNotNull(ViewModelProvider(activity)[SessionModel::class.java]
                        .uiState.value.ready).chats.refreshList()
                }
                val syncing = By.desc(labels.getString(R.string.chat_syncing))
                device.await(syncing)
                device.await(chatActions).click()
                device.await(text(R.string.chat_archive)).click()
                val rejection = labels.getString(
                    R.string.chat_row_action_rejected_named, labels.getString(R.string.chat_archive),
                )
                val errorBounds = device.await(By.text(rejection)).visibleBounds
                val undoBounds = device.await(undo).visibleBounds
                check(undoBounds.right < errorBounds.left)
                check(device.await(readingJump).visibleBounds.bottom < errorBounds.top)
                device.await(By.text("访谈整理").selected(true))
                device.waitForIdle()
                check(device.hasObject(syncing))
                check(device.hasObject(By.text(rejection)))
                ScreenshotCapture.capture("wide-pane-feedback.png")
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
