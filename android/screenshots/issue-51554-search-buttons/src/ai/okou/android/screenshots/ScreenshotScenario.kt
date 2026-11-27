package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun searchActionsKeepTheQueryAndSelectTheDestination() {
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
        fun checkTarget(bounds: android.graphics.Rect) {
            assertTrue("Touch target width is ${bounds.width()}", bounds.width() >= 48)
            assertTrue("Touch target height is ${bounds.height()}", bounds.height() >= 48)
        }
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
                WorkflowApiFixture(chinese = true, chats = chats).use { fixture ->
                    app.chatService = fixture.service
                    app.searchService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    ActivityScenario.launch(MainActivity::class.java).use {
                        device.awaitChatList(app)
                        get(desc(label(R.string.chat_search_workspace))).click()
                        editor()
                        awaitIme()
                        hideIme()
                        edit("发布")
                        get(text(artifacts.checklist.title))
                        val artifactsLabel = label(R.string.chat_search_artifacts)
                        val more = get(desc(localized.getString(R.string.chat_search_view_type, artifactsLabel)))
                        checkTarget(more.visibleBounds)
                        ScreenshotCapture.capture("view-all-$layout.png")
                        more.click()
                        get(By.pkg(app.packageName).selected(true).hasChild(By.text(artifactsLabel)))
                        assertEquals("发布", editor().text)

                        val unknown = "没有这样的成果"
                        edit(unknown)
                        get(text(label(R.string.chat_search_no_artifacts)))
                        val recovery = row(label(R.string.chat_search_all_types))
                        checkTarget(recovery.visibleBounds)
                        ScreenshotCapture.capture("search-all-types-$layout.png")
                        recovery.click()
                        get(By.pkg(app.packageName).selected(true).hasChild(By.text(label(R.string.chat_search_all))))
                        assertEquals(unknown, editor().text)
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
