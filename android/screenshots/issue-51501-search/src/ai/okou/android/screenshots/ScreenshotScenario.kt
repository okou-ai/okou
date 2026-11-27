package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.awaitChatList
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun searchUsesMaterialRowsAndWaitsForConfirmedEmpty() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val preferences = app.snapshotApiPreferences()
        val initial = app.initialPreferences
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size = device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val density = device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val font = device.executeShellCommand("settings get system font_scale").trim()
        val ime = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val localized = app.createConfigurationContext(
            Configuration(app.resources.configuration).apply {
                setLocales(LocaleList.forLanguageTags("zh-Hans"))
            },
        )
        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun desc(value: String) = By.pkg(app.packageName).desc(value)
        fun editor() = get(By.pkg(app.packageName).clazz("android.widget.EditText"))
        fun row(title: String) = generateSequence(get(text(title))) { it.parent }.first { it.isClickable }
        fun restore(scope: String, key: String, value: String) {
            if (value.toFloatOrNull() == null) device.executeShellCommand("settings delete $scope $key")
            else device.executeShellCommand("settings put $scope $key $value")
        }
        fun hideIme() {
            if (instrumentation.uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }) {
                assertTrue(device.pressBack())
                check(device.wait(object : Condition<UiDevice, Boolean> {
                    override fun apply(device: UiDevice) =
                        instrumentation.uiAutomation.windows.none { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
                }, 8_000))
            }
        }
        fun awaitIme() {
            check(device.wait(object : Condition<UiDevice, Boolean> {
                override fun apply(device: UiDevice) =
                    instrumentation.uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
            }, 8_000))
        }
        fun edit(query: String) {
            val field = editor()
            field.click()
            get(By.pkg(app.packageName).clazz("android.widget.EditText").focused(true)).text = query
            get(text(query).clazz("android.widget.EditText"))
            awaitIme()
            hideIme()
        }
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                auth.state.value = testAuthenticationState(user = "native-search-${UUID.randomUUID()}")
                app.initialPreferences = testPreferences().copy(
                    locale = UserPreferencesLocale.ZH_HANS,
                    theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                )
                val chats = ChatListApiFixture()
                val artifacts = ArtifactApiFixture(chats, chinese = true).also { it.install() }
                val releaseReads = CountDownLatch(1)
                val waitingKeyword = "蓝图"
                val failedKeyword = "未知"
                val message = "发布安排已更新，请核对上线时间。"
                WorkflowApiFixture(chinese = true, chats = chats).use { fixture ->
                    fixture.releasePurpose = "核对发布文案与素材。"
                    chats.searchMessages = { request ->
                        when (request.requestUrl?.queryParameter("keyword")) {
                            "发布" -> jsonResponse(
                                """{"results":[{"chatThreadId":"$CHAT_PERSONAL","agentName":"Okou","matchedMessage":{"chatThreadId":"$CHAT_PERSONAL","role":"assistant","content":"$message","createdAt":"$CHAT_DATE","seqId":37},"matchedRanges":[{"start":0,"end":2}]}]}""",
                            )
                            waitingKeyword -> {
                                check(releaseReads.await(15, TimeUnit.SECONDS))
                                jsonResponse("""{"results":[]}""")
                            }
                            failedKeyword -> jsonResponse("""{"error":{"code":"BAD_REQUEST","message":"Fixture read failed"}}""").setResponseCode(400)
                            else -> jsonResponse("""{"results":[]}""")
                        }
                    }
                    app.chatService = fixture.service
                    app.searchService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    try {
                        ActivityScenario.launch(MainActivity::class.java).use {
                            device.awaitChatList(app)
                            get(desc(label(R.string.chat_search_workspace))).click()
                            editor()
                            awaitIme()
                            hideIme()
                            assertEquals(48, editor().visibleBounds.height())
                            val recent = row(artifacts.sourceTitle)
                            assertEquals(56, recent.visibleBounds.height())
                            ScreenshotCapture.capture("search-recent-$layout.png")

                            edit("发布")
                            assertEquals(72, row(fixture.releaseTitle).visibleBounds.height())
                            get(text(artifacts.checklist.title))
                            get(text(message))
                            ScreenshotCapture.capture("search-grouped-$layout.png")

                            get(text(label(R.string.chat_search_messages))).click()
                            edit(waitingKeyword)
                            get(desc(label(R.string.chat_search_loading)))
                            assertTrue(!device.hasObject(text(label(R.string.chat_search_no_messages))))
                            ScreenshotCapture.capture("search-loading-$layout.png")
                            releaseReads.countDown()
                            get(text(label(R.string.chat_search_no_messages)))
                            ScreenshotCapture.capture("search-empty-$layout.png")

                            edit(failedKeyword)
                            get(text(label(R.string.chat_list_first_load_failed)))
                            assertTrue(!device.hasObject(text(label(R.string.chat_search_no_messages))))
                            ScreenshotCapture.capture("search-failed-$layout.png")
                        }
                    } finally {
                        releaseReads.countDown()
                    }
                }
            }
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(preferences)
            app.initialPreferences = initial
            cache.restore()
            restore("system", "font_scale", font)
            restore("secure", "show_ime_with_hard_keyboard", ime)
            device.executeShellCommand("wm size ${size.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${density.ifEmpty { "reset" }}")
        }
    }
}
