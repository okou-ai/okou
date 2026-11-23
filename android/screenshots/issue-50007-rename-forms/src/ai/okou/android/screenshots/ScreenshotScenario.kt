package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.awaitChatList
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesRenameAndDeleteOutcomes() {
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
        val personalTitle = "Android 设计讨论"
        val projectTitle = "产品研究"
        val history = "我们已核对工作区的聊天列表。"
        val chatRenameStatus = AtomicInteger(400)
        val chatRenames = AtomicInteger()
        val projectRenames = AtomicInteger()
        val chatDeletes = AtomicInteger()
        fixture.historyReply = history
        fixture.projects = {
            jsonResponse(
                """{"projects":[{"id":"$CHAT_PROJECT","name":"$projectTitle","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}],"latestEventId":null,"latestSeqId":0}""",
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
                chatEventWire(
                    id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    seq = 24,
                    thread = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    title = "每周汇总",
                ),
            )
            jsonResponse("""{"events":[${events.joinToString(",")}],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            when {
                request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL/rename" -> {
                    chatRenames.incrementAndGet()
                    MockResponse().setResponseCode(chatRenameStatus.get())
                }
                request.method == "PATCH" &&
                    request.requestUrl?.encodedPath == "/api/projects/$CHAT_PROJECT" -> {
                    projectRenames.incrementAndGet()
                    MockResponse().setResponseCode(409)
                }
                request.method == "DELETE" &&
                    request.requestUrl?.encodedPath == "/api/chat-threads/$CHAT_PERSONAL" -> {
                    chatDeletes.incrementAndGet()
                    MockResponse().setResponseCode(400)
                }
                else -> null
            }
        }

        fun text(label: String) = By.pkg(app.packageName).text(label)
        fun text(id: Int) = text(labels.getString(id))
        fun field(id: Int) = By.pkg(app.packageName).clazz("android.widget.EditText")
            .desc(labels.getString(id))

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
            auth.state.value = testAuthenticationState(user = "rename-forms-${UUID.randomUUID()}")
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("wm density 160")
            instrumentation.runOnMainSync { localeManager.applicationLocales = targetLocales }
            val activity = ActivityScenario.launch(MainActivity::class.java)
            scenario = activity
            device.awaitChatList(labels)
            activity.onActivity {
                val state = ViewModelProvider(it)[SessionModel::class.java].uiState.value
                val chats = state.ready?.chats ?: (state.opening as? OpeningWorkspace.Authorized)?.chats
                chatJob = checkNotNull(chats).viewModelScope.coroutineContext[Job]
            }

            val personal = text(personalTitle)
            val save = text(R.string.chat_project_rename_save)
            val cancel = text(R.string.chat_rename_cancel)
            val rejected = text(R.string.chat_rename_save_failed)
            val chatField = field(R.string.chat_title_field)
            val proposedTitle = "Android 导航验收"
            device.await(personal).longClick()
            device.await(text(R.string.chat_rename)).click()
            check(!device.await(save).isEnabled)
            device.await(chatField).setText(proposedTitle)
            check(device.await(chatField).visibleBounds.height() >= 56)
            device.await(save).click()
            device.await(rejected)
            check(device.await(chatField).text == proposedTitle)
            check(device.await(save).isEnabled)
            check(device.await(save).visibleBounds.height() >= 48)
            check(device.findObjects(rejected).size == 1 && chatRenames.get() == 1)
            ScreenshotCapture.capture("chat-rename-phone-rejected.png")
            device.await(cancel).click()

            chatRenameStatus.set(503)
            device.await(personal).longClick()
            device.await(text(R.string.chat_rename)).click()
            device.await(chatField).setText(proposedTitle)
            device.await(save).click()
            device.await(text(R.string.chat_rename_save_unconfirmed))
            device.await(text(R.string.chat_rename_check_result))
            check(device.await(chatField).text == proposedTitle && chatRenames.get() == 2)
            ScreenshotCapture.capture("chat-rename-phone-unknown.png")
            device.await(text(R.string.chat_rename_check_result)).click()
            device.await(rejected)
            check(chatRenames.get() == 2)
            device.await(cancel).click()
            check(device.wait(Until.gone(chatField), 10_000L))

            // The rejected delete should return the chat and present one notice in the list.
            val delete = text(R.string.chat_delete)
            val deleteTitle = text(R.string.chat_delete_title)
            val deleteFailure = text(R.string.chat_delete_rejected)
            fun confirmDelete() {
                device.await(deleteTitle)
                device.await(delete).click()
                device.awaitChatList(labels)
                device.await(personal)
                val notice = device.await(deleteFailure)
                check(device.hasObject(personal))
                check(notice.visibleBounds.centerY() > device.displayHeight / 2)
                check(device.findObjects(deleteFailure).size == 1 && !device.hasObject(deleteTitle))
            }
            device.await(personal).longClick()
            device.await(delete).click()
            confirmDelete()
            check(device.wait(Until.gone(deleteFailure), 10_000L))
            device.await(personal).click()
            device.await(text(history))
            device.await(By.pkg(app.packageName).desc(labels.getString(R.string.chat_actions))).click()
            device.await(delete).click()
            confirmDelete()
            check(chatDeletes.get() == 2)
            ScreenshotCapture.capture("chat-delete-phone-rejected.png")
            check(device.wait(Until.gone(deleteFailure), 10_000L))

            device.executeShellCommand("wm size 1000x1000")
            device.awaitChatList(labels)
            device.await(By.pkg(app.packageName).clazz("android.widget.EditText"))
            device.await(text(projectTitle)).longClick()
            device.await(text(R.string.chat_rename_confirm)).click()
            val projectField = field(R.string.chat_project_name)
            val proposedProjectTitle = "跨平台可用性研究"
            device.await(projectField).setText(proposedProjectTitle)
            device.await(save).click()
            device.await(rejected)
            val wideField = device.await(projectField)
            check(device.displayWidth == 1000 && wideField.visibleBounds.centerX() == 500)
            check(wideField.visibleBounds.height() >= 56 && wideField.text == proposedProjectTitle)
            check(device.await(save).isEnabled && projectRenames.get() == 1)
            ScreenshotCapture.capture("project-rename-wide-rejected.png")
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
