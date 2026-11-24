package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.auth.SessionModel
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.workflows.WorkflowModel
import ai.okou.android.workflows.WorkflowService
import android.graphics.Rect
import android.view.KeyEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowLayoutAndConfirmationStates() {
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
        val catalogFailure = AtomicBoolean(false)
        val toggleEntered = CountDownLatch(1)
        val releaseToggle = CountDownLatch(1)
        val toggleApplied = AtomicBoolean(false)
        val observedError = AtomicReference<String>()
        val readbackEntered = CountDownLatch(1)
        val releaseReadback = CountDownLatch(1)
        val disablePath = "/api/workflow-automations/weekday/disable"
        var workflowModel: WorkflowModel? = null

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

        fun pendingState(label: String): Rect {
            val observed = mutableListOf<String>()
            fun find(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
                if (
                    node.packageName?.toString() == app.packageName &&
                        (node.stateDescription != null ||
                            node.contentDescription?.toString() == "暂停")
                ) {
                    observed +=
                        "name=${node.contentDescription}, state=${node.stateDescription}, enabled=${node.isEnabled}"
                }
                if (
                    node.packageName?.toString() == app.packageName &&
                        node.stateDescription?.toString() == label
                )
                    return node
                for (index in 0 until node.childCount) {
                    val child = node.getChild(index) ?: continue
                    find(child)?.let {
                        return it
                    }
                }
                return null
            }
            val pending =
                checkNotNull(
                    device.wait(
                        object : Condition<UiDevice, AccessibilityNodeInfo?> {
                            override fun apply(device: UiDevice): AccessibilityNodeInfo? {
                                observed.clear()
                                return instrumentation.uiAutomation.rootInActiveWindow?.let(::find)
                            }
                        },
                        10_000,
                    ),
                ) {
                    "Missing disabled Pause state: $label. Observed: $observed; " +
                        "write result: ${observedError.get()}; " +
                        "toggle: ${workflowModel?.state?.value?.toggles?.get("weekday")}"
                }
            assertEquals("暂停", pending.contentDescription?.toString())
            assertFalse(pending.isEnabled)
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, pending.liveRegion)
            return Rect().also(pending::getBoundsInScreen)
        }

        fun focusScope(label: String): UiObject2 {
            repeat(20) {
                device.waitForIdle()
                val target = device.findObject(By.pkg(app.packageName).text(label))
                if (
                    target != null &&
                        generateSequence(target) { it.parent }.take(3).any { it.isFocused }
                )
                    return target
                device.pressKeyCode(KeyEvent.KEYCODE_TAB)
            }
            error("Could not focus the scrolled scope: $label")
        }

        try {
            val response = fixture.chats.commandResponse
            fixture.chats.commandResponse = { request ->
                when (request.requestUrl?.encodedPath) {
                    "/api/workflows" ->
                        if (catalogFailure.get()) MockResponse().setResponseCode(400)
                        else response(request)
                    disablePath -> {
                        toggleEntered.countDown()
                        assertTrue(releaseToggle.await(20, TimeUnit.SECONDS))
                        val applied =
                            checkNotNull(response(request)) { "Missing fixture toggle response" }
                        toggleApplied.set(true)
                        applied.setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY)
                    }
                    else -> response(request)
                }
            }
            fixture.beforeReleaseDetailRead = {
                if (toggleApplied.get()) {
                    readbackEntered.countDown()
                    assertTrue(releaseReadback.await(20, TimeUnit.SECONDS))
                }
            }
            fixture.active.set(true)
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.connectorService = connectors.service
            app.workflows =
                object : WorkflowService by fixture.service {
                    override suspend fun setAutomationEnabled(
                        id: String,
                        enabled: Boolean,
                    ): WorkflowAutomation =
                        try {
                            fixture.service.setAutomationEnabled(id, enabled)
                        } catch (error: Exception) {
                            observedError.set(
                                when (error) {
                                    is ApiFailure.Network ->
                                        "Network(${error.cause?.javaClass?.simpleName}, connectionFailed=${error.connectionFailed})"
                                    is ApiFailure.Http -> "HTTP ${error.status}"
                                    else -> error.javaClass.simpleName
                                },
                            )
                            throw error
                        }
                }
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
                    session = "workflow-design-${UUID.randomUUID()}",
                )
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put system font_scale 1.0")

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { assertEquals(412, it.resources.configuration.screenWidthDp) }
                openDirectory()
                text("需连接")
                assertTrue(action(fixture.releaseTitle).visibleBounds.height() >= 80)
                ScreenshotCapture.capture("phone-directory.png")

                text(fixture.releaseTitle).click()
                text("工作流说明")
                val use = action("在聊天中使用").visibleBounds
                assertEquals(20, use.left)
                assertEquals(392, use.right)
                assertTrue(use.height() >= 48)
                ScreenshotCapture.capture("phone-instructions.png")
                device.pressBack()
                assertTrue(
                    device.wait(
                        Until.hasObject(By.pkg(app.packageName).desc("搜索工作流")),
                        10_000,
                    ),
                )
                device.pressBack()
                text("Personal chat")

                catalogFailure.set(true)
                openDirectory()
                val feedback = text("暂时无法更新工作流目录，显示已加载内容").visibleBounds
                val firstRow = action(fixture.releaseTitle).visibleBounds
                assertEquals(16, feedback.left)
                assertEquals(12, firstRow.top - feedback.bottom)
                ScreenshotCapture.capture("phone-directory-refresh-failed.png")
                action("工作区共享").click()
                text(fixture.sharedTitle)
                assertTrue(
                    device.wait(
                        Until.gone(By.pkg(app.packageName).text(fixture.releaseTitle)),
                        10_000,
                    ),
                )
                catalogFailure.set(false)
            }

            device.executeShellCommand("wm size 1180x820")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { assertEquals(1180, it.resources.configuration.screenWidthDp) }
                openDirectory()
                text(fixture.releaseTitle).click()
                text("工作流说明")
                action("自动化").click()
                text("触发规则")
                text("已启用")
                scenario.onActivity {
                    workflowModel =
                        ViewModelProvider(it)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                            ?.workflows
                }
                text("已暂停 · 需连接")
                assertTrue(action("查看连接").isEnabled)
                val pause = action("暂停")
                val original = pause.visibleBounds
                assertTrue(original.height() >= 48)
                assertEquals(text("触发规则").visibleBounds.left, original.left)
                val footer = action("在聊天中使用").visibleBounds
                assertTrue(footer.height() >= 48)
                assertTrue(footer.left > original.left)
                ScreenshotCapture.capture("wide-automations.png")

                try {
                    pause.click()
                    assertTrue(toggleEntered.await(10, TimeUnit.SECONDS))
                    assertEquals(original, pendingState("正在保存…"))
                    text("已启用")
                    releaseToggle.countDown()
                    assertTrue(readbackEntered.await(10, TimeUnit.SECONDS))
                    assertEquals(original, pendingState("正在核对结果…"))
                    text("已启用")
                    ScreenshotCapture.capture("wide-toggle-readback.png")
                } finally {
                    releaseToggle.countDown()
                    releaseReadback.countDown()
                }
                action("启用")
                text("已暂停")
                assertEquals(
                    1,
                    fixture.requests.count { it.requestUrl?.encodedPath == disablePath },
                )
            }

            device.executeShellCommand("wm size 320x760")
            device.executeShellCommand("settings put system font_scale 2.0")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity {
                    assertEquals(320, it.resources.configuration.screenWidthDp)
                    assertEquals(2f, it.resources.configuration.fontScale)
                }
                openDirectory()
                val scopeTop = text("全部").visibleBounds.top
                val shared = focusScope("工作区共享")
                assertEquals(scopeTop, shared.visibleBounds.top)
                assertTrue(shared.visibleBounds.left >= 16)
                assertTrue(shared.visibleBounds.right <= 304)
                ScreenshotCapture.capture("phone-large-text.png")
            }
        } finally {
            releaseToggle.countDown()
            releaseReadback.countDown()
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
