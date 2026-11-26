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
import android.content.res.Configuration
import android.view.WindowInsets
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
import java.util.concurrent.CountDownLatch
import kotlin.math.roundToInt
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
    fun workflowPhoneKeepsTheFooterInTheSystemSafeArea() {
        WorkflowApiFixture(chinese = true).use { fixture ->
            ConnectorApiFixture().use { connectors ->
                val originalPreferences = app.initialPreferences
                val originalPreferenceData = app.snapshotApiPreferences()
                val auth = app.authentication as TestAuthentication
                val originalAuth = auth.state.value
                val originalChats = app.chatService
                val originalComposer = app.composerService
                val originalFlows = app.workflows
                val originalConnectors = app.connectorService
                try {
                    app.chatService = fixture.service
                    app.composerService = fixture.service
                    app.workflows = fixture.service
                    app.connectorService = connectors.service
                    app.restoreApiPreferences(emptyMap())
                    app.initialPreferences = testPreferences().copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
                    auth.state.value = testAuthenticationState(
                        user = "user-a",
                        session = "workflow-phone-${UUID.randomUUID()}",
                    )
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        lateinit var layout: PhoneLayout
                        scenario.onActivity { activity ->
                            val configuration = activity.resources.configuration
                            assertEquals(Configuration.ORIENTATION_PORTRAIT, configuration.orientation)
                            assertTrue(configuration.screenWidthDp < 840)
                            assertEquals(1f, configuration.fontScale, .001f)
                            val window = activity.windowManager.currentWindowMetrics
                            val insets = window.windowInsets.getInsets(
                                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
                            )
                            assertTrue(insets.bottom > 0)
                            layout = PhoneLayout(
                                density = activity.resources.displayMetrics.density,
                                contentLeft = window.bounds.left + insets.left,
                                contentBottom = window.bounds.bottom - insets.bottom,
                            )
                        }
                        capturePhone(fixture, layout)
                    }
                } finally {
                    app.chatService = originalChats
                    app.composerService = originalComposer
                    app.workflows = originalFlows
                    app.connectorService = originalConnectors
                    auth.state.value = originalAuth
                    app.initialPreferences = originalPreferences
                    app.restoreApiPreferences(originalPreferenceData)
                }
            }
        }
    }

    private fun capturePhone(fixture: WorkflowApiFixture, layout: PhoneLayout) {
        text("Personal chat")
        node(By.desc("工作流").enabled(true)).click()
        text("仅自己")
        val release = CountDownLatch(1)
        fixture.beforeReleaseDetailRead = { release.await() }
        val pendingBounds = try {
            action(fixture.releaseTitle).click()
            node(By.desc("工作流"))
            val button = ancestor(text("在聊天中使用")) { !it.isEnabled }
            button.visibleBounds.also { bounds ->
                assertTrue(bounds.height() >= layout.pixels(48) - 1)
                assertTrue(bounds.left in layout.contentLeft + layout.pixels(20) - 1..
                    layout.contentLeft + layout.pixels(20) + 1)
                assertTrue(bounds.bottom <= layout.contentBottom)
                ScreenshotCapture.capture("workflow-phone-loading.png")
            }
        } catch (failure: Throwable) {
            runCatching {
                TestStorage().openOutputFile("phone-loading-failure.xml")
                    .use(device::dumpWindowHierarchy)
                ScreenshotCapture.capture("phone-loading-failure.png")
            }
            throw failure
        } finally {
            release.countDown()
        }

        text("工作流说明")
        val tabs = listOf("说明", "自动化", "运行记录").map { label ->
            ancestor(text(label)) { it.isFocusable }.visibleBounds
        }
        assertTrue(tabs.all { it.height() >= layout.pixels(48) - 1 })
        assertTrue(tabs.maxOf { it.width() } - tabs.minOf { it.width() } <= 1)
        assertEquals(pendingBounds, action("在聊天中使用").visibleBounds)
        ScreenshotCapture.capture("workflow-phone-detail.png")
    }

    private class PhoneLayout(val density: Float, val contentLeft: Int, val contentBottom: Int) {
        fun pixels(dp: Int): Int = (dp * density).roundToInt()
    }

    private fun node(selector: BySelector): UiObject2 =
        checkNotNull(device.wait(Until.findObject(selector.pkg(app.packageName)), 15_000)) {
            "Missing workflow selector $selector"
        }

    private fun text(label: String): UiObject2 = node(By.text(label))

    private fun ancestor(label: UiObject2, match: (UiObject2) -> Boolean): UiObject2 =
        checkNotNull(generateSequence(label) { it.parent }.firstOrNull(match)) {
            "Missing native control for ${label.text}"
        }

    private fun action(label: String): UiObject2 = ancestor(text(label)) { it.isClickable }
}
