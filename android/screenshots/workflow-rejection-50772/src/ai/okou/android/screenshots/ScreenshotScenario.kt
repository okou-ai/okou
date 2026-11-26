package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.workflows.WorkflowModel
import android.app.LocaleManager
import android.os.LocaleList
import android.view.KeyEvent
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.takeScreenshot
import androidx.test.core.graphics.writeToTestStorage
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun workflowEditorAndNativeTimePicker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val originalAuthentication = authentication.state.value
        val originalPreferences = app.snapshotApiPreferences()
        val originalChatService = app.chatService
        val originalWorkflows = app.workflows
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val cachedChats = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val device = UiDevice.getInstance(instrumentation)
        val fixture = WorkflowApiFixture(chinese = true)
        try {
            localeManager.applicationLocales = LocaleList.forLanguageTags("zh-Hans")
            app.restoreApiPreferences(
                mapOf(
                    Triple(BuildConfig.API_ORIGIN, "user-a", "org-a") to
                        testPreferences().copy(
                            locale = UserPreferencesLocale.ZH_HANS,
                            theme = UserPreferencesTheme.LIGHT,
                        ),
                ),
            )
            app.chatService = fixture.service
            app.workflows = fixture.service
            authentication.state.value = testAuthenticationState()
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                fun visible(selector: BySelector) =
                    checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                        "Missing workflow control: $selector"
                    }
                fun text(label: String) = visible(By.pkg(app.packageName).text(label))
                fun control(id: Int) = visible(By.pkg(app.packageName).text(app.getString(id)).enabled(true))
                fun action(id: Int) = control(id).click()
                fun nameField(value: String) =
                    By.pkg(app.packageName).clazz("android.widget.EditText")
                        .text(value)

                fun entry() =
                    By.pkg(app.packageName)
                        .desc(app.getString(R.string.workspace_workflows))
                        .enabled(true)

                assertTrue(
                    "The localized workflow entry becomes available",
                    device.wait(
                        object : Condition<UiDevice, Boolean> {
                            override fun apply(current: UiDevice): Boolean = current.hasObject(entry())
                        },
                        10_000,
                    ) == true,
                )
                visible(entry()).click()
                text(fixture.releaseTitle).click()
                action(R.string.workflow_edit_instructions)
                visible(By.pkg(app.packageName).desc(app.getString(R.string.workflow_name)))
                ScreenshotCapture.capture("15-workflow-editor.png")

                lateinit var model: WorkflowModel
                scenario.onActivity { activity ->
                    val session = ViewModelProvider(activity)[SessionModel::class.java]
                    model = checkNotNull(session.uiState.value.ready?.workflows)
                }
                try {
                    val draftName = "发布前核对负责人和时间"
                    val latestInstruction = "网页版已更新发布清单，请核对最新内容。"
                    val submitted = CountDownLatch(1)
                    fixture.beforeInstructionSave = {
                        fixture.instruction = latestInstruction
                        submitted.countDown()
                    }
                    fixture.instructionSaveConflict = true
                    visible(nameField(fixture.releaseTitle)).text = draftName
                    visible(nameField(draftName))
                    action(R.string.workflow_save)
                    assertTrue("The enabled Save reaches the workflow PATCH", submitted.await(10, TimeUnit.SECONDS))
                    assertTrue(
                        "The editor reads the confirmed workflow after the server rejects the save",
                        device.wait(
                            object : Condition<UiDevice, Boolean> {
                                override fun apply(unused: UiDevice): Boolean =
                                    model.state.value.detail?.instruction == latestInstruction
                            },
                            10_000,
                        ) == true,
                    )
                    assertEquals(draftName, visible(nameField(draftName)).text)
                    val conflict = text(app.getString(R.string.workflow_write_conflict))
                    val save = control(R.string.workflow_save)
                    assertTrue(conflict.visibleBounds.bottom <= save.visibleBounds.top)
                    ScreenshotCapture.capture("18-workflow-save-conflict.png")
                } catch (failure: Throwable) {
                    try {
                        takeScreenshot().writeToTestStorage("native-workflow-conflict-failure.png")
                    } catch (diagnostic: Throwable) {
                        failure.addSuppressed(diagnostic)
                    }
                    throw failure
                }

                action(R.string.workflow_cancel)
                action(R.string.workflow_discard)
                action(R.string.workflow_automations)
                action(R.string.workflow_add_automation)
                val timeSelector = By.pkg(app.packageName).desc(app.getString(R.string.workflow_time))
                visible(timeSelector)
                ScreenshotCapture.capture("16-automation-editor.png")
                visible(timeSelector).click()
                visible(By.res("android:id/button1"))
                ScreenshotCapture.capture("17-system-time-picker.png")
                assertTrue(device.pressKeyCode(KeyEvent.KEYCODE_BACK))
                visible(timeSelector)
            }
        } finally {
            fixture.close()
            cachedChats.restore()
            app.chatService = originalChatService
            app.workflows = originalWorkflows
            app.restoreApiPreferences(originalPreferences)
            localeManager.applicationLocales = originalLocale
            authentication.state.value = originalAuthentication
        }
    }
}
