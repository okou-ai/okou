package ai.okou.android.screenshots

import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.content.res.Configuration
import android.os.LocaleList
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
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
    fun workflowIntroductionRestoresWithItsQuery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalSearch = app.searchService
        val originalComposer = app.composerService
        val originalWorkflows = app.workflows
        val apiPreferences = app.snapshotApiPreferences()
        val initialPreferences = app.initialPreferences
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val size =
            device.executeShellCommand("wm size").substringAfter("Override size: ", "").trim()
        val density =
            device.executeShellCommand("wm density").substringAfter("Override density: ", "").trim()
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val showIme =
            device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObjects(selector), 12_000)) {
                    "Missing workflow search element $selector"
                }
                .minBy { it.visibleBounds.left }
        fun button(id: Int) = get(By.pkg(app.packageName).desc(label(id)))
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun editor() = get(By.pkg(app.packageName).clazz("android.widget.EditText"))
        fun restoreSetting(scope: String, name: String, value: String) {
            if (value.toFloatOrNull() == null)
                device.executeShellCommand("settings delete $scope $name")
            else device.executeShellCommand("settings put $scope $name $value")
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                auth.state.value = testAuthenticationState(user = "workflow-search-${UUID.randomUUID()}")
                app.initialPreferences =
                    testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = if (wide) UserPreferencesTheme.DARK else UserPreferencesTheme.LIGHT,
                    )
                WorkflowApiFixture(chinese = true).use { fixture ->
                    app.chatService = fixture.service
                    app.searchService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    val originalTitle = fixture.releaseTitle
                    val keyword = "检查流程"
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        fun hideKeyboard() {
                            scenario.onActivity { activity ->
                                WindowCompat.getInsetsController(
                                        activity.window,
                                        activity.window.decorView,
                                    )
                                    .hide(WindowInsetsCompat.Type.ime())
                            }
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice) =
                                            instrumentation.uiAutomation.windows.none {
                                                it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD
                                            }
                                    },
                                    10_000,
                                ),
                            )
                        }
                        fun openIntro(query: String) {
                            editor().text = query
                            hideKeyboard()
                            assertEquals(query, editor().text)
                            assertEquals(48, editor().visibleBounds.height())
                            val row = generateSequence(text(originalTitle)) { it.parent }
                                .first { it.isClickable }
                            assertTrue(row.visibleBounds.height() >= 52)
                            row.click()
                            text(label(R.string.chat_search_workflow_details))
                        }
                        val details = By.pkg(app.packageName)
                            .text(label(R.string.chat_search_workflow_details))
                        button(R.string.chat_search_workspace).click()
                        text(label(R.string.chat_search_workflows)).click()
                        openIntro(keyword)
                        scenario.recreate()
                        get(details)
                        text(label(R.string.chat_search_workflow_add_draft))
                        ScreenshotCapture.capture("workflow-intro-$layout.png")
                        device.pressBack()
                        assertTrue(device.wait(Until.gone(details), 10_000))
                        assertEquals(keyword, editor().text)
                        get(By.pkg(app.packageName).selected(true)
                            .hasChild(By.text(label(R.string.chat_search_workflows))))

                        openIntro(keyword.padEnd(257))
                        scenario.recreate()
                        assertTrue(device.wait(Until.gone(details), 10_000))
                        get(By.pkg(app.packageName).selected(true)
                            .hasChild(By.text(label(R.string.chat_search_all))))
                        assertTrue(!editor().text.orEmpty().contains(keyword))
                        ScreenshotCapture.capture("workflow-reset-$layout.png")
                    }
                }
            }
        } finally {
            app.chatService = originalChats
            app.searchService = originalSearch
            app.composerService = originalComposer
            app.workflows = originalWorkflows
            auth.state.value = originalAuth
            app.restoreApiPreferences(apiPreferences)
            app.initialPreferences = initialPreferences
            cache.restore()
            restoreSetting("system", "font_scale", fontScale)
            restoreSetting("secure", "show_ime_with_hard_keyboard", showIme)
            device.executeShellCommand("wm size ${size.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${density.ifEmpty { "reset" }}")
        }
    }
}
