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
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.services.storage.TestStorage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
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
    fun workflowEditorOverlays() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val previousAuth = auth.state.value
        val previousChats = app.chatService
        val previousComposer = app.composerService
        val previousWorkflows = app.workflows
        val previousConnectors = app.connectorService
        val previousConnectivity = app.connectivity.value
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

        val calendar = "Google Calendar · 创建日程"
        val gmail = "Gmail · 收到邮件"
        val instruction = "### 发布前确认\n![发布截图](<https://example.test/release.png>)"
        val discardTitle = "放弃修改？"
        val discardDetail = "你在这台设备上对「${fixture.releaseTitle}」尚未保存的修改将被丢弃。"

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

        fun captureMenu(label: String, filename: String): BySelector {
            val anchor = action(label)
            val anchorBottom = anchor.visibleBounds.bottom
            val checked = By.pkg(app.packageName).checked(true).hasChild(By.text(label))
            anchor.click()
            val option = checkNotNull(device.wait(Until.findObject(checked), 10_000)) {
                "Missing selected menu option: $label"
            }
            val bounds = option.visibleBounds
            assertEquals("244dp menu with 7dp inner padding", 230, bounds.width())
            assertTrue("48dp menu rows", bounds.height() >= 48)
            assertEquals("4dp anchor gap and 7dp padding", 11, bounds.top - anchorBottom)
            ScreenshotCapture.capture(filename)
            return checked
        }

        fun captureDiscard(width: Int, filename: String) {
            action("取消").click()
            text(discardTitle)
            val details = text(discardDetail).visibleBounds
            assertEquals("360dp dialog with a 24dp inset", (width - 360) / 2 + 24, details.left)
            assertTrue(action("继续编辑").visibleBounds.height() >= 48)
            assertTrue(action("放弃修改").visibleBounds.height() >= 48)
            ScreenshotCapture.capture(filename)
        }

        fun verifyWindow(width: Int, height: Int, verify: () -> Unit) {
            device.executeShellCommand("wm size ${width}x${height}")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                try {
                    scenario.onActivity { assertEquals(width, it.resources.configuration.screenWidthDp) }
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
            app.connectivity.value = true
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
            device.executeShellCommand("settings put system font_scale 1.0")

            verifyWindow(412, 892) {
                openDirectory()
                text(fixture.releaseTitle).click()
                text("工作流说明")
                action("自动化").click()
                action("添加自动化").click()
                val frequency = captureMenu("工作日", "phone-frequency-menu.png")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                assertTrue(device.wait(Until.gone(frequency), 10_000))

                action("事件").click()
                captureMenu(calendar, "phone-event-source-menu.png")
                action(gmail).click()
                text("标题包含")
                captureDiscard(412, "phone-automation-discard.png")
                action("继续编辑").click()
                text("标题包含")
            }

            verifyWindow(1180, 820) {
                openDirectory()
                text(fixture.releaseTitle).click()
                text(instruction)
                action("编辑说明").click()
                text(instruction)
                ScreenshotCapture.capture("wide-instructions-source.png")

                val displayName = checkNotNull(
                    device.wait(
                        Until.findObject(By.pkg(app.packageName).clazz("android.widget.EditText").text(fixture.releaseTitle)),
                        10_000,
                    ),
                )
                displayName.text = "Draft title"
                captureDiscard(1180, "wide-instructions-discard.png")
                action("放弃修改").click()
                text(instruction)
            }
        } finally {
            try {
                app.chatService = previousChats
                app.composerService = previousComposer
                app.workflows = previousWorkflows
                app.connectorService = previousConnectors
                app.connectivity.value = previousConnectivity
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
