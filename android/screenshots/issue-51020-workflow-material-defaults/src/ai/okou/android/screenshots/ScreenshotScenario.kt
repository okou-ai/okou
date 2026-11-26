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
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val app = instrumentation.targetContext.applicationContext as TestOkouApplication

    @Test
    fun workflowMaterialDefaults() {
        val originalSize = displayOverride("size", "\\d+x\\d+")
        val originalDensity = displayOverride("density", "\\d+")
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val originalPreferences = app.initialPreferences
        val originalPreferenceData = app.snapshotApiPreferences()
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChats = app.chatService
        val originalComposer = app.composerService
        val originalFlows = app.workflows
        val originalConnectors = app.connectorService
        try {
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")

            withWindow(760, 440, UserPreferencesTheme.LIGHT) { fixture ->
                openDirectory()
                action(fixture.releaseTitle).click()
                tab("自动化").click()
                text("触发规则")
                assertTrue(action("在聊天中使用").visibleBounds.height() >= 47)
                ScreenshotCapture.capture("compact-automations.png")
            }
        } finally {
            app.chatService = originalChats
            app.composerService = originalComposer
            app.workflows = originalFlows
            app.connectorService = originalConnectors
            auth.state.value = originalAuth
            app.initialPreferences = originalPreferences
            app.restoreApiPreferences(originalPreferenceData)
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            if (originalScale.toFloatOrNull() == null) {
                device.executeShellCommand("settings delete system font_scale")
            } else {
                device.executeShellCommand("settings put system font_scale $originalScale")
            }
        }
    }

    private fun withWindow(
        width: Int,
        height: Int,
        theme: UserPreferencesTheme,
        capture: (WorkflowApiFixture) -> Unit,
    ) {
        WorkflowApiFixture(chinese = true).use { fixture ->
            ConnectorApiFixture().use { connectors ->
                fixture.active.set(true)
                app.chatService = fixture.service
                app.composerService = fixture.service
                app.workflows = fixture.service
                app.connectorService = connectors.service
                app.restoreApiPreferences(emptyMap())
                app.initialPreferences =
                    testPreferences()
                        .copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = theme,
                            timezone = "Asia/Shanghai",
                        )
                (app.authentication as TestAuthentication).state.value =
                    testAuthenticationState(
                        user = "user-a",
                        session = "workflow-material-${UUID.randomUUID()}",
                    )
                device.executeShellCommand("wm size ${width}x${height}")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        scenario.onActivity {
                            assertEquals(width, it.resources.configuration.screenWidthDp)
                            assertEquals(160, it.resources.configuration.densityDpi)
                            assertEquals(1f, it.resources.configuration.fontScale, 0.001f)
                        }
                        capture(fixture)
                    } catch (failure: Throwable) {
                        runCatching {
                            TestStorage()
                                .openOutputFile("capture-failure.xml")
                                .use(device::dumpWindowHierarchy)
                            ScreenshotCapture.capture("capture-failure.png")
                        }
                        throw failure
                    }
                }
            }
        }
    }

    private fun displayOverride(setting: String, pattern: String): String? =
        Regex("Override $setting: ($pattern)")
            .find(device.executeShellCommand("wm $setting"))
            ?.groupValues
            ?.get(1)

    private fun openDirectory() {
        text("Personal chat")
        checkNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).desc("工作流").enabled(true)),
                    10_000,
                ),
            )
            .click()
        text("仅自己")
    }

    private fun text(label: String): UiObject2 =
        checkNotNull(device.wait(Until.findObject(By.pkg(app.packageName).text(label)), 15_000)) {
            "Missing native text: $label"
        }

    private fun tab(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isFocusable }) {
            "Missing native tab: $label"
        }

    private fun action(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing native action: $label"
        }

}
