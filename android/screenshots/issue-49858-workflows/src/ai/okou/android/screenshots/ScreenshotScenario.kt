package ai.okou.android.screenshots

import ai.okou.android.ConnectorApiFixture
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
import android.graphics.Color
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowDirectoryDetailAndDraft() {
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
        val size = device.executeShellCommand("wm size")
        val density = device.executeShellCommand("wm density")
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(size)?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(density)?.groupValues?.get(1)
        val originalScale = device.executeShellCommand("settings get system font_scale").trim()
        val fixture = WorkflowApiFixture(chinese = true)
        val connectorFixture = ConnectorApiFixture()
        val draft = "/release-review 保留原有草稿"
        fun text(value: String, exact: Boolean = false): UiObject2 {
            val selector = By.pkg(app.packageName)
            val match = if (exact) selector.text(value) else selector.textContains(value)
            return checkNotNull(device.wait(Until.findObject(match), 10_000)) {
                "Missing native text: $value"
            }
        }
        fun workflowWrites() =
            fixture.requests.count {
                it.requestUrl?.encodedPath?.startsWith("/api/workflow") == true &&
                    (it.method == "POST" || it.method == "PATCH")
            }
        fun tapSaveWithoutWriting() {
            val center = text("保存", exact = true).visibleCenter
            val before = workflowWrites()
            assertTrue(device.click(center.x, center.y))
            instrumentation.waitForIdleSync()
            text("保存", exact = true)
            assertEquals(
                "The blocked save must not send a workflow write",
                before,
                workflowWrites(),
            )
        }
        fun back() {
            assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        }
        fun entry(label: String) =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).desc(label)), 10_000)
            ) {
                "Missing native control: $label"
            }
        fun toolEntry(label: String) =
            checkNotNull(
                device.wait(
                    Until.findObject(By.pkg(app.packageName).desc(label).enabled(true)),
                    10_000,
                )
            ) {
                "Missing native tool entry: $label"
            }
        fun workflowsEntry() = toolEntry("工作流")
        fun withNativeEditor(
            scenario: ActivityScenario<MainActivity>,
            field: UiObject2,
            verify: (InputConnection) -> Unit,
        ) {
            field.click()
            instrumentation.waitForIdleSync()
            lateinit var input: InputConnection
            scenario.onActivity { activity ->
                val view =
                    checkNotNull(activity.currentFocus) { "The editor did not receive focus" }
                input =
                    checkNotNull(view.onCreateInputConnection(EditorInfo())) {
                        "The editor has no native input connection"
                    }
            }
            try {
                verify(input)
            } finally {
                scenario.onActivity { input.closeConnection() }
            }
        }

        try {
            app.chatService = fixture.service
            app.composerService = fixture.service
            app.workflows = fixture.service
            app.connectorService = connectorFixture.service
            app.connectivity.value = true
            app.initialPreferences =
                testPreferences()
                    .copy(
                        locale = UserPreferencesLocale.ZH_HANS,
                        theme = UserPreferencesTheme.LIGHT,
                        timezone = "Asia/Shanghai",
                    )
            auth.state.value =
                testAuthenticationState(user = "workflow-screenshots-${UUID.randomUUID()}")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("wm size 280x820")
            device.executeShellCommand("settings put system font_scale 2.0")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                text("Personal chat")
                scenario.onActivity { activity ->
                    assertTrue(activity.resources.configuration.fontScale >= 2f)
                    assertTrue(activity.resources.configuration.screenWidthDp == 280)
                }
                val entries = listOf("工作流", "连接器", "成果").map { toolEntry(it).visibleBounds }
                assertTrue(entries.zipWithNext().all { (left, right) -> left.right < right.left })
                assertTrue(entries.all { it.height() >= 48 && it.width() >= 48 })
                ScreenshotCapture.capture("workflows-chat-list-large-text.png")
            }

            device.executeShellCommand("wm size 412x892")
            device.executeShellCommand("settings put system font_scale 1.0")

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                text("Personal chat")
                val entry = workflowsEntry()
                val search =
                    checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).desc("搜索工作区")), 10_000)
                    )
                assertTrue(entry.visibleBounds.top >= search.visibleBounds.bottom)
                ScreenshotCapture.capture("workflows-chat-list-entry.png")
                toolEntry("连接器").click()
                text("发现", exact = true)
                text("Google Calendar", exact = true)
                back()
                text("Personal chat")
                workflowsEntry().click()
                text(fixture.releaseTitle)
                text("发布后跟进")
                text("客户反馈汇总")
                text("需连接")
                ScreenshotCapture.capture("workflows-phone-list.png")

                val releaseDetail = CountDownLatch(1)
                fixture.beforeReleaseDetailRead = { releaseDetail.await() }
                val pendingAction =
                    try {
                        text(fixture.releaseTitle).click()
                        checkNotNull(
                            device.wait(
                                Until.findObject(By.pkg(app.packageName).desc("工作流")),
                                10_000,
                            )
                        )
                        val pendingUse = text("在聊天中使用", exact = true)
                        assertFalse(pendingUse.isEnabled)
                        ScreenshotCapture.capture("workflows-phone-detail-loading.png")
                        pendingUse.visibleBounds
                    } finally {
                        releaseDetail.countDown()
                        fixture.beforeReleaseDetailRead = {}
                    }
                text("核对发布文案和产品说明")
                val activeUse = text("在聊天中使用", exact = true)
                assertTrue(activeUse.isEnabled)
                assertEquals(pendingAction, activeUse.visibleBounds)
                ScreenshotCapture.capture("workflows-phone-instructions.png")

                app.connectivity.value = false
                fixture.disconnectDraftRead = true
                val draftError = "未能打开新聊天草稿。已有草稿已保留，请检查网络后重试。"
                val use = text("在聊天中使用", exact = true)
                assertFalse(device.hasObject(By.pkg(app.packageName).text(draftError)))
                use.click()
                val notice = text(draftError, exact = true)
                assertTrue(
                    notice.visibleBounds.bottom <= text("在聊天中使用", exact = true).visibleBounds.top
                )
                assertFalse(device.hasObject(By.pkg(app.packageName).textContains(draft)))
                ScreenshotCapture.capture("workflows-phone-offline.png")
                fixture.disconnectDraftRead = false
                app.connectivity.value = true
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).text(draftError)), 10_000)
                )

                text("编辑说明").click()
                text("保存")
                ScreenshotCapture.capture("workflows-phone-edit.png")
                val edit = "准备发布检查"
                withNativeEditor(scenario, entry("显示名称")) { editor ->
                    scenario.onActivity {
                        assertTrue(editor.setSelection(0, fixture.releaseTitle.length))
                        assertTrue(editor.commitText(edit, 1))
                    }
                    text(edit, exact = true)
                }
                app.connectivity.value = false
                fixture.disconnectInstructionSave = true
                val saveError = "联网后可保存，修改已保留。"
                assertFalse(device.hasObject(By.pkg(app.packageName).text(saveError)))
                text("保存", exact = true).click()
                val saveNotice = text(saveError, exact = true)
                assertTrue(
                    saveNotice.visibleBounds.bottom <= text("保存", exact = true).visibleBounds.top
                )
                text(edit, exact = true)
                ScreenshotCapture.capture("workflows-phone-save-network-failed.png")
                fixture.disconnectInstructionSave = false
                app.connectivity.value = true
                assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text(saveError)), 10_000))
                text("取消").click()
                text("放弃修改", exact = true).click()
                text("在聊天中使用")

                text("自动化").click()
                text("触发规则")
                text(fixture.ruleTitle)
                text("上海（UTC+8）")
                text("已暂停 · 需连接")
                ScreenshotCapture.capture("workflows-phone-automations.png")

                text("运行记录").click()
                text("最近自动化运行")
                ScreenshotCapture.capture("workflows-phone-history.png")
                text(fixture.ruleTitle).click()
                text("Personal chat")
                back()
                text("最近自动化运行")
                checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).text("自动化")), 10_000)
                    )
                    .click()
                text("已暂停 · 需连接")

                text("在聊天中使用").click()
                text(draft)
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).textContains("正在同步草稿")), 10_000)
                )
                assertFalse(
                    fixture.requests.any {
                        it.method == "POST" &&
                            it.requestUrl?.encodedPath in
                                setOf("/api/chat-threads", "/api/chat/events")
                    }
                )
                ScreenshotCapture.capture("workflows-phone-draft.png")

                back()
                text(fixture.ruleTitle)
                device.executeShellCommand("wm size 1180x820")
                text("搜索工作流")
                val ruleBounds = text(fixture.ruleTitle).visibleBounds
                assertTrue(text("搜索工作流").visibleBounds.right < ruleBounds.left)
                checkNotNull(
                        device.wait(Until.findObject(By.pkg(app.packageName).text("启用")), 10_000)
                    )
                    .click()
                text("下次运行")
                text("上海（UTC+8）")
                text("在聊天中使用")
                ScreenshotCapture.capture("workflows-wide-automations.png")

                text("在聊天中使用").click()
                text(draft)
                ScreenshotCapture.capture("workflows-wide-draft.png")
                toolEntry("连接器").click()
                text("发现", exact = true)
                back()
                text(draft)
                lateinit var returnLabel: String
                scenario.onActivity { returnLabel = it.getString(R.string.back) }
                entry(returnLabel).click()
                text("触发规则")
                text("下次运行")

                device.executeShellCommand("wm size 900x450")
                device.executeShellCommand("settings put system font_scale 2.0")
                assertTrue(
                    device.wait(Until.gone(By.pkg(app.packageName).textContains("搜索工作流")), 10_000)
                )
                text("在聊天中使用")
                scenario.onActivity { activity ->
                    assertTrue(activity.resources.configuration.fontScale >= 2f)
                    assertTrue(activity.resources.configuration.screenHeightDp < 480)
                }
                checkNotNull(
                        device.wait(
                            Until.findObject(By.pkg(app.packageName).scrollable(true)),
                            10_000,
                        )
                    )
                    .scroll(Direction.DOWN, 0.85f)
                text(fixture.ruleTitle)
                ScreenshotCapture.capture("workflows-short-large-text.png")
            }

            fixture.githubAppInstalled = true
            fixture.hasSharedSchedule = true
            device.executeShellCommand("wm size 1180x820")
            device.executeShellCommand("settings put system font_scale 1.0")
            ActivityScenario.launch(MainActivity::class.java).use {
                workflowsEntry().click()
                text(fixture.releaseTitle, exact = true).click()
                text("自动化", exact = true).click()
                text("GitHub 拉取请求变更")
                text("example/release", exact = true)
                text("启用", exact = true)
                ScreenshotCapture.capture("workflows-wide-github-automation.png")
                text("启用", exact = true).click()
                assertTrue(device.wait(Until.gone(By.pkg(app.packageName).text("启用")), 10_000))
                text("GitHub 拉取请求变更")
                assertTrue(device.findObjects(By.pkg(app.packageName).text("已启用")).size == 2)
                assertTrue(
                    fixture.requests.any {
                        it.method == "POST" &&
                            it.requestUrl?.encodedPath == "/api/workflow-automations/github/enable"
                    }
                )

                text(fixture.sharedTitle, exact = true).click()
                text("整理发布发现。", exact = true)
                assertFalse(device.hasObject(By.pkg(app.packageName).text("编辑说明")))
                text("自动化", exact = true).click()
                text(fixture.ruleTitle)
                assertFalse(device.hasObject(By.pkg(app.packageName).text("添加自动化")))
                text("暂停", exact = true)
                ScreenshotCapture.capture("workflows-wide-shared-automation.png")
                text("暂停", exact = true).click()
                text("已暂停", exact = true)
            }

            device.executeShellCommand("wm size 412x892")
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                workflowsEntry().click()
                text(fixture.releaseTitle, exact = true)
                withNativeEditor(scenario, entry("搜索工作流")) { editor ->
                    scenario.onActivity { assertTrue(editor.setComposingText("jiancha", 1)) }
                    text("jiancha", exact = true)
                    text(fixture.releaseTitle, exact = true)
                    text(fixture.sharedTitle, exact = true)
                    ScreenshotCapture.capture("workflows-phone-search-composing.png")

                    scenario.onActivity { assertTrue(editor.commitText("检查", 1)) }
                    text("检查", exact = true)
                    text(fixture.releaseTitle, exact = true)
                    assertTrue(
                        device.wait(
                            Until.gone(By.pkg(app.packageName).text(fixture.sharedTitle)),
                            10_000,
                        )
                    )
                }

                text(fixture.releaseTitle, exact = true).click()
                text("编辑说明", exact = true).click()
                withNativeEditor(scenario, entry("显示名称")) { editor ->
                    scenario.onActivity {
                        assertTrue(editor.setSelection(0, fixture.releaseTitle.length))
                        assertTrue(editor.commitText("", 1))
                    }
                    text("请输入显示名称。", exact = true)
                    ScreenshotCapture.capture("workflows-phone-edit-name-error.png")
                }
                tapSaveWithoutWriting()
                text("请输入显示名称。", exact = true)
                withNativeEditor(scenario, entry("显示名称")) { editor ->
                    scenario.onActivity { assertTrue(editor.commitText("准备发布检查", 1)) }
                    text("准备发布检查", exact = true)
                }
                text("取消", exact = true).click()
                text("放弃未保存的修改？", exact = true)
                text("继续编辑", exact = true)
                text("放弃修改", exact = true)
                ScreenshotCapture.capture("workflows-phone-discard.png")

                device.executeShellCommand("wm size 900x280")
                device.executeShellCommand("settings put system font_scale 2.0")
                device.waitForIdle()
                scenario.onActivity { activity ->
                    assertTrue(activity.resources.configuration.fontScale >= 2f)
                    assertTrue(activity.resources.configuration.screenHeightDp <= 280)
                }
                text("放弃未保存的修改？", exact = true)
                text("继续编辑", exact = true)
                val discard = text("放弃修改", exact = true)
                assertTrue(
                    "The compact dialog background dim did not appear after resizing",
                    device.wait(
                        Condition<UiDevice, Boolean> {
                            val frame =
                                instrumentation.uiAutomation.takeScreenshot()
                                    ?: return@Condition false
                            try {
                                frame.width == 900 &&
                                    frame.height == 280 &&
                                    Color.luminance(frame.getPixel(16, frame.height / 2)) < 0.5f
                            } finally {
                                frame.recycle()
                            }
                        },
                        10_000,
                    ),
                )
                ScreenshotCapture.capture("workflows-short-discard.png")
                discard.click()
                device.executeShellCommand("wm size 412x892")
                device.executeShellCommand("settings put system font_scale 1.0")
                text(fixture.releaseTitle, exact = true)

                text("自动化", exact = true).click()
                text("添加自动化", exact = true).click()
                text("定时", exact = true).click()
                text("收到邮件", exact = true).click()
                text("保存这条规则需要连接 Gmail。", exact = true)
                val cancel = text("取消", exact = true)
                val connection = text("查看连接", exact = true)
                val save = text("保存", exact = true)
                assertTrue(cancel.visibleBounds.right < connection.visibleBounds.left)
                assertTrue(connection.visibleBounds.right < save.visibleBounds.left)
                ScreenshotCapture.capture("workflows-phone-automation-needs-connection.png")
                withNativeEditor(scenario, entry("标题包含")) { editor ->
                    scenario.onActivity { assertTrue(editor.commitText("准备发布", 1)) }
                    text("准备发布", exact = true)
                }
                tapSaveWithoutWriting()
                text("准备发布", exact = true)
            }
        } finally {
            app.chatService = previousChats
            app.composerService = previousComposer
            app.workflows = previousWorkflows
            app.connectorService = previousConnectors
            app.connectivity.value = previousConnectivity
            app.initialPreferences = previousPreferences
            app.restoreApiPreferences(previousPreferenceData)
            auth.state.value = previousAuth
            fixture.use { connectorFixture.close() }
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
