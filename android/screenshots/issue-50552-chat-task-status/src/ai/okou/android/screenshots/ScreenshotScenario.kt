package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.TestRealtimeService
import ai.okou.android.api.generated.IndicatorsTaskStatesValue
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesChatTaskStates() {
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
        val size = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val density = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)

        val fixture = ChatListApiFixture()
        val running = AtomicBoolean(false)
        val personal = "整理本周访谈"
        val project = "产品研究"
        val projectChat = "汇总用户反馈"
        val idleChat = "制定下周计划"
        val runningId = "22222222-2222-4222-8222-000000000018"
        val mutedId = "22222222-2222-4222-8222-000000000019"
        val idleId = "22222222-2222-4222-8222-000000000020"
        fun row(sequence: Long, threadId: String, title: String, extra: String = "", kind: String = "created") =
            sequence to chatEventWire(
                id = "77777777-7777-4777-8777-${sequence.toString().padStart(12, '0')}",
                seq = sequence,
                thread = threadId,
                title = title,
                extra = extra,
                kind = kind,
            )
        val rows = listOf(
            row(17L, CHAT_PERSONAL, personal),
            row(18L, runningId, "分析试用数据"),
            row(19L, mutedId, "归档发布通知"),
            row(20L, idleId, idleChat),
            row(21L, CHAT_IN_PROJECT, projectChat, ",\"projectId\":\"$CHAT_PROJECT\""),
            row(22L, mutedId, "归档发布通知", ",\"muted\":true", "sort_touched"),
        )
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
            val tail = rows.filter { it.first > since }.joinToString(",") { it.second }
            jsonResponse("""{"events":[$tail],"hasMore":false}""")
        }
        fixture.projects = {
            jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"$project","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""")
        }
        fixture.indicators = {
            val phase = if (running.get()) "running" else "queued"
            jsonResponse(
                """{
                    "threads":{"$CHAT_PERSONAL":"active","$runningId":"active"},
                    "unreadAt":{"$CHAT_PERSONAL":"$CHAT_DATE"},
                    "taskStates":{
                        "$CHAT_PERSONAL":"$phase","$CHAT_IN_PROJECT":"queued","$runningId":"running","$mutedId":"queued"
                    }
                }""",
            )
        }
        fixture.historyThreadIds = fixture.historyThreadIds + idleId
        fixture.historyReply = "我会先列出本周的重点，再确认下周的安排。"
        val realtime = app.realtimeService as TestRealtimeService

        try {
            app.chatService = fixture.service
            app.connectivity.value = true
            app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
            auth.state.value = testAuthenticationState(user = "chat-task-state-${UUID.randomUUID()}")
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("wm density 160")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun awaitTask(expected: IndicatorsTaskStatesValue) {
                    device.awaitActivity(scenario, "$expected for $personal") { activity ->
                        ViewModelProvider(activity)[SessionModel::class.java]
                            .uiState.value.ready?.chats?.uiState?.value?.indicators
                            ?.taskStates?.get(CHAT_PERSONAL) == expected
                    }
                }

                device.awaitChatList(labels)
                awaitTask(IndicatorsTaskStatesValue.QUEUED)
                device.awaitText(personal)
                device.awaitText(project)
                check(!device.hasObject(By.text(projectChat)))
                device.waitForIdle()
                ScreenshotCapture.capture("phone-queued.png")

                running.set(true)
                realtime.invalidate(ChatChanges(messageThreads = setOf(CHAT_PERSONAL)))
                awaitTask(IndicatorsTaskStatesValue.RUNNING)
                device.waitForIdle()
                ScreenshotCapture.capture("phone-running.png")

                device.executeShellCommand("wm size 1180x920")
                device.awaitActivity(scenario, "a wide window") { activity ->
                    activity.resources.configuration.screenWidthDp >= 1100
                }
                device.awaitChatList(labels)
                device.awaitText(project).click()
                device.awaitText(projectChat)
                device.awaitText(idleChat).click()
                device.awaitText(fixture.historyReply)
                check(device.wait(Until.hasObject(By.text(idleChat).selected(true)), 10_000L))
                device.waitForIdle()
                ScreenshotCapture.capture("wide-project.png")
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

    private fun UiDevice.awaitText(text: String) =
        checkNotNull(wait(Until.findObject(By.text(text)), 10_000L)) { "Missing $text" }

    private fun UiDevice.awaitActivity(
        scenario: ActivityScenario<MainActivity>,
        description: String,
        isReady: (MainActivity) -> Boolean,
    ) {
        val condition = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice): Boolean {
                var ready = false
                scenario.onActivity { ready = isReady(it) }
                return ready
            }
        }
        check(wait(condition, 10_000L)) { "Expected $description" }
    }
}
