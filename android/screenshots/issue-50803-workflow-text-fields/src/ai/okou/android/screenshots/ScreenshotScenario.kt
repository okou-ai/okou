package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowOutlinedFields() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousConnectors = app.connectorService
        val previousPreferences = app.initialPreferences
        val previousPreferenceData = app.snapshotApiPreferences()
        val originalSize =
            Regex("Override size: (\\d+x\\d+)")
                .find(device.executeShellCommand("wm size"))
                ?.groupValues
                ?.get(1)
        val originalDensity =
            Regex("Override density: (\\d+)")
                .find(device.executeShellCommand("wm density"))
                ?.groupValues
                ?.get(1)
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)
        val connectors = ConnectorApiFixture()

        val instruction = "### 发布前确认\n![发布截图](<https://example.test/release.png>)"
        val displayNameError = "请输入显示名称。"
        val displayNameLengthError = "最多输入 256 个字符。"

        fun text(label: String): UiObject2 =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 15_000),
            ) {
                "Missing native text: $label"
            }

        fun action(label: String): UiObject2 =
            checkNotNull(
                generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable },
            ) {
                "Missing native action: $label"
            }

        fun openDirectory() {
            text("Personal chat")
            checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).desc("工作流").enabled(true)),
                        10_000,
                    ),
                )
                .click()
            text(fixture.releaseTitle)
        }

        fun input(value: String): UiObject2 =
            checkNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText").text(value)),
                    10_000,
                ),
            ) { "Missing native text input: $value" }

        fun openInstructions() {
            openDirectory()
            text(fixture.releaseTitle).click()
            action("编辑说明").click()
            input(fixture.releaseTitle)
        }

        fun verifyWindow(width: Int, height: Int, fontScale: Float = 1f, verify: () -> Unit) {
            device.executeShellCommand("wm size ${width}x${height}")
            device.executeShellCommand("settings put system font_scale $fontScale")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                try {
                    scenario.onActivity {
                        assertEquals(width, it.resources.configuration.screenWidthDp)
                        assertEquals(fontScale, it.resources.configuration.fontScale, 0.001f)
                    }
                    verify()
                } catch (error: Throwable) {
                    runCatching {
                        TestStorage().openOutputFile("capture-failure.xml")
                            .use(device::dumpWindowHierarchy)
                    }
                    throw error
                }
            }
        }

        try {
            fixture.active.set(true)
            fixture.instruction = instruction
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.connectorService = connectors.service
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(
                    user = "user-a",
                    session = "workflow-editor-${UUID.randomUUID()}",
                )
            device.executeShellCommand("wm density 160")

            verifyWindow(412, 892) {
                openInstructions()
                val purposeTop = text("用途").visibleBounds.top
                ScreenshotCapture.capture("phone-workflow-instructions.png")
                input(fixture.releaseTitle).text = " "
                text(displayNameError)
                assertEquals("The error uses the reserved supporting line", purposeTop, text("用途").visibleBounds.top)
                ScreenshotCapture.capture("phone-name-validation.png")
                input(" ").text = fixture.releaseTitle
                assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(displayNameError)), 5_000))
                assertEquals(purposeTop, text("用途").visibleBounds.top)
            }

            verifyWindow(1180, 820) {
                openInstructions()
                assertEquals(instruction, input(instruction).text)
                ScreenshotCapture.capture("wide-workflow-instructions.png")
                action("取消").click()
                action("自动化").click()
                action("添加自动化").click()
                action("事件").click()
                input("primary")
                ScreenshotCapture.capture("wide-calendar-automation.png")
            }

            verifyWindow(240, 892, fontScale = 2f) {
                openInstructions()
                val purposeTop = text("用途").visibleBounds.top
                ScreenshotCapture.capture("narrow-workflow-instructions.png")
                input(fixture.releaseTitle).text = "x".repeat(257)
                text(displayNameLengthError)
                device.waitForIdle()
                assertTrue("The wrapped message expands the supporting area", text("用途").visibleBounds.top > purposeTop)
                ScreenshotCapture.capture("narrow-wrapped-validation.png")
                input("x".repeat(257)).text = fixture.releaseTitle
                assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(displayNameLengthError)), 5_000))
                device.waitForIdle()
                assertEquals(purposeTop, text("用途").visibleBounds.top)
            }
        } finally {
            try {
                app.chatService = previousChats
                app.composerService = previousComposer
                app.workflows = previousWorkflows
                app.connectorService = previousConnectors
                app.initialPreferences = previousPreferences
                app.restoreApiPreferences(previousPreferenceData)
                auth.state.value = previousAuth
                connectors.use { fixture.close() }
            } finally {
                if (originalScale.toFloatOrNull() == null) {
                    device.executeShellCommand("settings delete system font_scale")
                } else {
                    device.executeShellCommand("settings put system font_scale $originalScale")
                }
                device.executeShellCommand("wm size ${originalSize ?: "reset"}")
                device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            }
        }
    }
}
