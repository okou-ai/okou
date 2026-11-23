package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatListModel
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.plainDraftDocument
import ai.okou.android.chatEventWire
import ai.okou.android.chatListRegion
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesDraftsOnPhoneAndWithAChatSelectedInAWideWindow() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val savedAuth = auth.state.value
        val savedChatService = app.chatService
        val savedComposerService = app.composerService
        val savedConnectorService = app.connectorService
        val savedWorkflowService = app.workflows
        val savedOnline = app.connectivity.value
        val savedPreferences = app.snapshotApiPreferences()
        val savedInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val savedLocales = localeManager.applicationLocales
        val targetLocales = LocaleList.forLanguageTags("zh-Hans")
        val labels = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply { setLocales(targetLocales) },
        )
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val fixture = ChatListApiFixture()
        val connectors = ConnectorApiFixture()
        val workflows = WorkflowApiFixture(chinese = true)
        val muted = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        val ordinary = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        val personalTitle = "Android 设计讨论"
        val draftText = "补一张宽窗截图，再确认草稿和运行状态。"
        val historyReply = "我已整理出两种窗口下的聊天列表。"
        val draftIds = setOf(CHAT_PERSONAL, CHAT_IN_PROJECT, muted)
        fixture.historyReply = historyReply
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"产品研究","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
            )
        }
        fixture.events = { request ->
            val events = if (request.requestUrl?.queryParameter("sinceSeqId") != null) emptyList()
            else listOf(
                chatEventWire(title = personalTitle),
                chatEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 23,
                    thread = CHAT_IN_PROJECT,
                    extra = ",\"projectId\":\"$CHAT_PROJECT\"",
                    title = "访谈整理",
                ),
                chatEventWire(id = muted, seq = 24, thread = muted, title = "通知草稿"),
                chatEventWire(
                    id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    seq = 25,
                    thread = muted,
                    kind = "sort_touched",
                    extra = ",\"muted\":true",
                    title = "通知草稿",
                ),
                chatEventWire(id = ordinary, seq = 26, thread = ordinary, title = "每周汇总"),
            )
            jsonResponse("""{"events":[${events.joinToString(",")}],"hasMore":false}""")
        }
        fixture.draftIndex = {
            jsonResponse("""{"draftThreadIds":["$CHAT_PERSONAL","$CHAT_IN_PROJECT","$muted"]}""")
        }
        fixture.commandResponse = { request ->
            if (
                request.method == "GET" &&
                    request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/draft"
            ) jsonResponse(plainDraftDocument(draftText).toString())
            else null
        }
        val failures = mutableListOf<Throwable>()
        var scenario: ActivityScenario<MainActivity>? = null
        var chatJob: Job? = null
        val originalSize = Regex("Override size: (\\d+x\\d+)")
            .find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)")
            .find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        try {
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.connectorService = connectors.service
            app.workflows = workflows.service
            app.connectivity.value = true
            app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
            auth.state.value = testAuthenticationState(user = "chat-drafts-${UUID.randomUUID()}")
            instrumentation.runOnMainSync { localeManager.applicationLocales = targetLocales }
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity
            device.awaitChatList(labels)
            var model: ChatListModel? = null
            activity.onActivity {
                val state = ViewModelProvider(it)[SessionModel::class.java].uiState.value
                model = state.ready?.chats ?: (state.opening as? OpeningWorkspace.Authorized)?.chats
            }
            val chats = checkNotNull(model)
            chatJob = chats.viewModelScope.coroutineContext[Job]
            val indexReady = object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    val state = chats.uiState.value
                    return state.draftThreadIds == draftIds && state.indicatorsPhase == ChatReadPhase.Ready
                }
            }
            check(device.wait(indexReady, 10_000L)) { "The draft and activity reads did not finish" }
            val newChat = By.pkg(app.packageName).text("新聊天")
            device.await(newChat)
            val project = By.pkg(app.packageName).text("产品研究")
            device.await(project).longClick()
            device.await(By.pkg(app.packageName).text("在项目中新建聊天"))
            check(device.pressBack())
            device.await(project).click()
            device.await(By.pkg(app.packageName).text("访谈整理"))
            device.await(By.pkg(app.packageName).text("通知草稿"))
            device.await(By.pkg(app.packageName).text("每周汇总"))
            val personal = By.pkg(app.packageName).text(personalTitle)
            device.await(personal)
            ScreenshotCapture.capture("chat-list-drafts-phone.png")

            device.executeShellCommand("wm size 1000x1000")
            device.executeShellCommand("wm density 160")
            val list = device.awaitChatList(labels)
            val editor = By.pkg(app.packageName).clazz("android.widget.EditText").enabled(true)
            val welcomeEditor = device.await(editor)
            check(list.visibleBounds.right < welcomeEditor.visibleBounds.left)
            ScreenshotCapture.capture("chat-list-drafts-wide-welcome.png")

            device.await(personal).click()
            val rightPane = device.await(By.pkg(app.packageName).text(historyReply))
            check(list.visibleBounds.right < rightPane.visibleBounds.left)
            val normalActionBottom = device.await(newChat).visibleBounds.bottom
            device.await(By.copy(personal).hasAncestor(chatListRegion(labels)))
            device.await(By.pkg(app.packageName).text("访谈整理"))
            device.await(By.pkg(app.packageName).text(draftText))
            ScreenshotCapture.capture("chat-list-drafts-wide.png")

            device.await(editor).click()
            val keyboardAndActionReady = object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice): Boolean {
                    var keyboardVisible = false
                    activity.onActivity {
                        keyboardVisible = ViewCompat.getRootWindowInsets(it.window.decorView)
                            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
                    }
                    val actionBottom = device.findObject(newChat)?.visibleBounds?.bottom
                    return keyboardVisible && actionBottom != null && actionBottom < normalActionBottom
                }
            }
            check(device.wait(keyboardAndActionReady, 10_000L)) {
                "The floating action did not move above the visible keyboard"
            }
            device.waitForIdle()
            device.await(By.pkg(app.packageName).text(draftText))
            ScreenshotCapture.capture("chat-list-drafts-wide-keyboard.png")
        } catch (error: Throwable) {
            failures += error
        } finally {
            for (cleanup in listOf<() -> Unit>(
                { scenario?.close() },
                { runBlocking { withTimeout(10_000) { chatJob?.join() } } },
                { fixture.close() },
                { connectors.close() },
                { workflows.close() },
                { savedCache.restore() },
                { app.restoreApiPreferences(savedPreferences) },
                { app.initialPreferences = savedInitialPreferences },
                { app.chatService = savedChatService },
                { app.composerService = savedComposerService },
                { app.connectorService = savedConnectorService },
                { app.workflows = savedWorkflowService },
                { app.connectivity.value = savedOnline },
                { auth.state.value = savedAuth },
                { instrumentation.runOnMainSync { localeManager.applicationLocales = savedLocales } },
                { device.executeShellCommand("wm size ${originalSize ?: "reset"}") },
                { device.executeShellCommand("wm density ${originalDensity ?: "reset"}") },
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

    private fun UiDevice.await(selector: BySelector) =
        checkNotNull(wait(Until.findObject(selector), 10_000L)) { "Missing $selector" }
}
