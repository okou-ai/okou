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
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
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
    fun blankDisplayNameHasAVisibleTitleOnPhoneAndWide() {
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
        val localized =
            app.createConfigurationContext(
                Configuration(app.resources.configuration).apply {
                    setLocales(LocaleList.forLanguageTags("zh-Hans"))
                },
            )
        fun label(id: Int) = localized.getString(id)
        fun get(selector: BySelector) =
            checkNotNull(device.wait(Until.findObjects(selector), 12_000)) {
                    "Missing workflow title element $selector"
                }
                .minBy { it.visibleBounds.left }
        fun button(id: Int) = get(By.pkg(app.packageName).desc(label(id)))
        fun text(value: String) = get(By.pkg(app.packageName).text(value))
        fun restoreSetting(scope: String, name: String, value: String) {
            if (value.toFloatOrNull() == null)
                device.executeShellCommand("settings delete $scope $name")
            else device.executeShellCommand("settings put $scope $name $value")
        }

        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            for (layout in listOf("phone", "wide")) {
                val wide = layout == "wide"
                device.executeShellCommand("wm size ${if (wide) "1000x800" else "412x892"}")
                auth.state.value = testAuthenticationState(user = "workflow-title-${UUID.randomUUID()}")
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
                    fixture.releaseTitle = "   "
                    fixture.active.set(wide)
                    val command = "release-review"
                    ActivityScenario.launch(MainActivity::class.java).use {
                        button(R.string.workspace_workflows).click()
                        val caption = text(command)
                        val row = generateSequence(caption) { it.parent }.first { it.isClickable }
                        assertTrue(row.visibleBounds.height() >= 80)
                        val search = get(By.pkg(app.packageName).clazz("android.widget.EditText"))
                        assertEquals(48, search.visibleBounds.height())
                        if (!wide) ScreenshotCapture.capture("workflow-directory-phone.png")
                        row.click()

                        val action = text(label(R.string.workflow_use_in_chat))
                        val footer = generateSequence(action) { it.parent }.first { it.isClickable }
                        assertTrue(footer.visibleBounds.height() >= 48)
                        assertEquals(if (wide) 968 else 392, footer.visibleBounds.right)
                        if (!wide) assertEquals(20, footer.visibleBounds.left)
                        val title = checkNotNull(
                            device.wait(Until.findObjects(By.pkg(app.packageName).text(command)), 5_000),
                        ).maxBy { it.visibleBounds.left }
                        assertEquals(if (wide) 352 else 20, title.visibleBounds.left)
                        text("/$command")
                        val tabs =
                            listOf(R.string.workflow_instructions, R.string.workflow_automations, R.string.workflow_history)
                                .map { id ->
                                    generateSequence(text(label(id))) { it.parent }.first { it.isClickable }
                                }
                        val tabWidths = tabs.map { it.visibleBounds.width() }
                        assertTrue(tabWidths.max() - tabWidths.min() <= 1)
                        assertTrue(tabs.all { it.visibleBounds.height() >= 48 })
                        ScreenshotCapture.capture("workflow-detail-$layout.png")
                        if (wide) {
                            tabs[1].click()
                            text(label(R.string.workflow_trigger_rules))
                            text(fixture.ruleTitle)
                            ScreenshotCapture.capture("workflow-automation-wide.png")
                            text(label(R.string.workflow_instructions)).click()
                        }

                        text(label(R.string.workflow_edit_instructions)).click()
                        val field = get(
                            By.pkg(app.packageName).clazz("android.widget.EditText").text(command),
                        )
                        assertEquals(command, field.text)
                        assertTrue(field.isEnabled)
                        ScreenshotCapture.capture("workflow-editor-$layout.png")
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
            device.executeShellCommand("wm size ${size.ifEmpty { "reset" }}")
            device.executeShellCommand("wm density ${density.ifEmpty { "reset" }}")
        }
    }
}
