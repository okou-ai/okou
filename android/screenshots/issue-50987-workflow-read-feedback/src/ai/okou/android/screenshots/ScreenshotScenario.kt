package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WORKFLOW_RELEASE
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
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import okhttp3.mockwebserver.MockResponse
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
    fun workflowReadFeedback() {
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

            withWindow(412, 892, UserPreferencesTheme.LIGHT) { _, fail ->
                fail.set("/api/workflows")
                openDirectory()
                val status = text(failureLabel)
                assertTrue(text("全部").visibleBounds.bottom < status.visibleBounds.top)
                assertTrue(abs(206 - status.visibleBounds.centerX()) <= 1)
                assertTrue(device.hasObject(By.pkg(app.packageName).desc("搜索工作流")))
                ScreenshotCapture.capture("phone-catalog-failure-light.png")
            }
            withWindow(412, 892, UserPreferencesTheme.LIGHT) { fixture, fail ->
                fail.set("/api/workflows/$WORKFLOW_RELEASE/run-history")
                openDirectory()
                action(fixture.releaseTitle).click()
                text("工作流说明")
                action("运行记录").click()
                val historyStatus = text(failureLabel).visibleBounds
                assertTrue(text("最近自动化运行").visibleBounds.bottom < historyStatus.top)
                assertTrue(action("在聊天中使用").isEnabled)
                ScreenshotCapture.capture("phone-history-failure-light.png")
            }
            withWindow(412, 892, UserPreferencesTheme.DARK) { fixture, fail ->
                fail.set("/api/workflows/$WORKFLOW_RELEASE")
                openDirectory()
                action(fixture.releaseTitle).click()
                val status = text(failureLabel).visibleBounds
                assertTrue(abs(206 - status.centerX()) <= 1)
                val use =
                    checkNotNull(
                        generateSequence(text("在聊天中使用")) { it.parent }
                            .firstOrNull { !it.isEnabled },
                    )
                assertTrue(status.bottom < use.visibleBounds.top)
                assertTrue(!use.isEnabled)
                ScreenshotCapture.capture("phone-detail-failure-dark.png")
            }
            withWindow(1180, 820, UserPreferencesTheme.DARK) { fixture, fail ->
                openDirectory()
                action(fixture.releaseTitle).click()
                val heading = text("工作流说明").visibleBounds
                val row = action(fixture.releaseTitle).visibleBounds
                val use = action("在聊天中使用").visibleBounds
                fail.set("/api/workflows/$WORKFLOW_RELEASE")
                action("自动化").click()
                val snackbar = text("未能刷新，继续显示已加载内容。").visibleBounds
                text("触发规则")
                assertEquals(row, action(fixture.releaseTitle).visibleBounds)
                assertEquals(use, action("在聊天中使用").visibleBounds)
                assertTrue(snackbar.left > row.right)
                assertTrue(snackbar.bottom < use.top)
                assertEquals(heading.left, text("触发规则").visibleBounds.left)
                ScreenshotCapture.capture("wide-cached-detail-dark.png")
            }
            withWindow(760, 440, UserPreferencesTheme.LIGHT) { _, fail ->
                fail.set("/api/workflows")
                openDirectory()
                val status = text(failureLabel).visibleBounds
                assertTrue(text("全部").visibleBounds.bottom < status.top)
                ScreenshotCapture.capture("compact-catalog-failure-light.png")
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
        capture: (WorkflowApiFixture, AtomicReference<String?>) -> Unit,
    ) {
        val failedPath = AtomicReference<String?>(null)
        WorkflowApiFixture(chinese = true).use { fixture ->
            ConnectorApiFixture().use { connectors ->
                fixture.active.set(true)
                val respond = fixture.chats.commandResponse
                fixture.chats.commandResponse = { request ->
                    val path = request.requestUrl?.encodedPath
                    if (path != null && path == failedPath.get()) {
                        MockResponse().setResponseCode(400)
                    } else respond(request)
                }
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
                        session = "workflow-reads-${UUID.randomUUID()}",
                    )
                device.executeShellCommand("wm size ${width}x${height}")
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    try {
                        scenario.onActivity {
                            assertEquals(width, it.resources.configuration.screenWidthDp)
                            assertEquals(160, it.resources.configuration.densityDpi)
                            assertEquals(1f, it.resources.configuration.fontScale, 0.001f)
                        }
                        capture(fixture, failedPath)
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

    private fun action(label: String): UiObject2 =
        checkNotNull(generateSequence(text(label)) { it.parent }.firstOrNull { it.isClickable }) {
            "Missing native action: $label"
        }

    private companion object {
        const val failureLabel = "暂时无法加载"
    }
}
