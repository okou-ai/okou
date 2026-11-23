package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.HISTORY_RUN
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.Workflows
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.workflows.WorkflowService
import android.content.res.Configuration
import android.os.LocaleList
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowSearchRecoversInPlace() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val originalConnectivity = app.connectivity.value
        val originalPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val localized = app.createConfigurationContext(Configuration(app.resources.configuration).apply {
            setLocales(LocaleList.forLanguageTags("zh-Hans"))
        })
        val originalCache =
            ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val originalDensity =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val workflows = WorkflowApiFixture(chinese = true)
        val fixture = workflows.chats
        val artifacts = ArtifactApiFixture(fixture, chinese = true).apply { install() }
        val offline = AtomicBoolean(false)
        val failedReads = AtomicInteger()
        val message = "请核对发布说明"
        val readyTitle = workflows.releaseTitle
        val updatedTitle = "发布检查流程已更新"
        val keyword = "发布"

        auth.state.value = testAuthenticationState(user = "workflow-search-${UUID.randomUUID()}")
        app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
        app.chatService = fixture.service
        app.searchService = fixture.service
        app.composerService = fixture.service
        app.workflows =
            object : WorkflowService by fixture.service {
                override suspend fun workflows(): Workflows {
                    if (offline.get()) {
                        failedReads.incrementAndGet()
                        throw ApiFailure.Network(IOException("Fixture directory unreachable"))
                    }
                    return fixture.service.workflows()
                }
            }
        fixture.searchMessages = { request ->
            if (request.requestUrl?.queryParameter("keyword") == keyword) {
                jsonResponse(
                    """
                    {"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou",
                      "matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant",
                      "content":"$message","createdAt":"$CHAT_DATE","seqId":22,"runId":"$HISTORY_RUN"},
                      "matchedRanges":[{"start":3,"end":5}]}]}
                    """
                )
            } else jsonResponse("""{"results":[]}""")
        }

        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) {
                "Missing search verification control: $selector"
            }
        fun label(id: Int) = localized.getString(id)
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun button(id: Int) = get(By.pkg(app.packageName).desc(label(id)))
        fun field() =
            checkNotNull(device.wait(Until.findObjects(
                By.pkg(app.packageName).clazz("android.widget.EditText"),
            ), 12_000)).minBy { it.visibleBounds.left }
        fun tab(id: Int) {
            val value = label(id)
            val control =
                checkNotNull(device.wait(Until.findObjects(By.pkg(app.packageName).text(value)), 12_000))
                    .minBy { it.visibleBounds.top }.parent
            check(control.isClickable && !control.isSelected)
            control.click()
            get(By.pkg(app.packageName).selected(true).hasChild(By.text(value)))
        }
        fun capture(name: String) {
            device.waitForIdle()
            ScreenshotCapture.capture(name)
        }
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun openSearch() {
                    button(R.string.chat_search_workspace).click()
                    get(By.pkg(app.packageName).clazz("android.widget.EditText").focused(true))
                }
                fun enter() {
                    field().text = keyword
                    tab(R.string.chat_search_workflows)
                    tab(R.string.chat_search_all)
                    scenario.onActivity { activity ->
                        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                            .hide(WindowInsetsCompat.Type.ime())
                    }
                    assertEquals(keyword, field().text)
                }
                try {
                    device.awaitChatList(localized)
                    text(artifacts.sourceTitle)
                    openSearch()
                    val input = field().visibleBounds
                    val firstType = get(By.pkg(app.packageName).selected(true)
                        .hasChild(By.text(label(R.string.chat_search_all)))).visibleBounds
                    assertEquals(48, input.height())
                    assertEquals(8, firstType.top - input.bottom)
                    assertEquals(48, firstType.height())
                    enter()
                    text(readyTitle)
                    button(R.string.back).click()
                    device.awaitChatList(localized)

                    offline.set(true)
                    app.connectivity.value = false
                    openSearch()
                    enter()
                    val partial = "部分结果暂时不可用"
                    val cached = "暂时无法更新工作流目录，仅搜索已加载的目录"
                    val noticeBounds = text(partial).visibleBounds
                    val chatRow = generateSequence(text(artifacts.sourceTitle)) { it.parent }
                        .first { it.isClickable }.visibleBounds
                    assertEquals(52, chatRow.height())
                    assertEquals(12, noticeBounds.left - chatRow.left)
                    text(message)
                    text(readyTitle)
                    text(artifacts.summary.title)
                    assertEquals(3, failedReads.get())
                    capture("search-partial-phone.png")

                    tab(R.string.chat_search_workflows)
                    text(cached)
                    text(readyTitle)
                    assertEquals(keyword, field().text)
                    capture("workflow-cached-phone.png")
                    tab(R.string.chat_search_all)

                    device.executeShellCommand("wm size 1000x800")
                    assertTrue(device.wait(Until.hasObject(By.pkg(app.packageName).text(partial)), 12_000))
                    assertTrue(field().visibleBounds.right < 480)
                    text(message)
                    text(readyTitle)
                    capture("search-partial-wide.png")

                    workflows.releaseTitle = updatedTitle
                    offline.set(false)
                    app.connectivity.value = true
                    text(updatedTitle)
                    assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(partial)), 12_000))
                    assertFalse(device.hasObject(By.pkg(app.packageName).text(readyTitle)))
                    assertEquals(keyword, field().text)
                    get(By.pkg(app.packageName).selected(true)
                        .hasChild(By.text(label(R.string.chat_search_all))))
                    text(message)
                    capture("search-recovered-wide.png")
                } catch (failure: Throwable) {
                    runCatching {
                        TestStorage().openOutputFile("workflow-search-window.xml")
                            .use(device::dumpWindowHierarchy)
                    }.exceptionOrNull()?.let(failure::addSuppressed)
                    throw failure
                }
            }
        } finally {
            app.searchService = originalSearch
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            app.connectivity.value = originalConnectivity
            auth.state.value = originalAuth
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = initialPreferences
            workflows.close()
            originalCache.restore()
            device.executeShellCommand("wm size ${originalSize.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${originalDensity.ifEmpty { "reset" }}")
        }
    }
}
