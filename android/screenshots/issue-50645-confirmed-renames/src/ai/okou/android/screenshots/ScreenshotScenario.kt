package ai.okou.android.screenshots

import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.CHAT_PROJECT
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.SessionModel
import ai.okou.android.chatEventWire
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.roundToInt
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesSavingAndConfirmedRenamesBeforeFeedReadback() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalWorkflows = app.workflows
        val originalConnectors = app.connectorService
        val originalPreferences = app.snapshotApiPreferences()
        val originalInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels =
            app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocales(locales) })
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = device.overrideValue("wm size", "Override size: (\\d+x\\d+)")
        val originalDensity = device.overrideValue("wm density", "Override density: (\\d+)")
        val fontScale = device.executeShellCommand("settings get system font_scale").trim()
        val motionScale = device.executeShellCommand("settings get global animator_duration_scale").trim()
        try {
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            app.initialPreferences =
                testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS, theme = UserPreferencesTheme.LIGHT)
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }

            for ((project, unconfirmed) in listOf(false to false, false to true, true to false, true to true)) {
                val prefix = if (project) "wide-project" else "phone-chat"
                val oldName = if (project) "用户研究" else "制定下周计划"
                val newName = if (project) "产品访谈" else "整理下周行动"
                val confirmedName = when {
                    project && unconfirmed -> newName
                    project -> "客户访谈"
                    unconfirmed -> "下周行动安排"
                    else -> newName
                }
                val laterEventId = "12345678-1234-4567-8567-123456789abc"
                val writeStarted = CountDownLatch(1)
                val releaseWrite = CountDownLatch(1)
                val readStarted = CountDownLatch(1)
                val releaseRead = CountDownLatch(1)
                val rejectFirstWrite = AtomicBoolean(project && !unconfirmed)
                val operation = AtomicReference<String>()
                val readsAfterWrite = AtomicInteger()
                val releaseUnconfirmedEvent = AtomicBoolean()
                val writes = AtomicInteger()
                val fixture = ChatListApiFixture()
                fixture.projects = {
                    jsonResponse("""{"projects":[{"id":"$CHAT_PROJECT","name":"用户研究","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"}],"latestEventId":null,"latestSeqId":0}""")
                }
                fixture.events = { request ->
                    val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong()
                    val event = operation.get()
                    val rows =
                        if (since == null) chatEventWire(seq = 17, title = "制定下周计划")
                        else if (!project && event != null && since < 18) {
                            if (unconfirmed) {
                                readsAfterWrite.incrementAndGet()
                                if (releaseUnconfirmedEvent.get()) {
                                    listOf(
                                        chatEventWire(id = event, seq = 18, kind = "renamed", title = newName),
                                        chatEventWire(
                                            id = laterEventId,
                                            seq = 19,
                                            kind = "renamed",
                                            title = confirmedName,
                                        ),
                                    ).joinToString(",")
                                } else ""
                            } else {
                                readStarted.countDown()
                                check(releaseRead.await(45, TimeUnit.SECONDS))
                                chatEventWire(id = event, seq = 18, kind = "renamed", title = newName)
                            }
                        } else ""
                    jsonResponse("""{"events":[$rows],"hasMore":false}""")
                }
                fixture.projectEvents = { request ->
                    val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLong() ?: 0
                    val event = operation.get()
                    val rows =
                        if (project && event != null && since < 1) {
                            val original =
                                """{"id":"$event","seqId":1,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"$newName","createdAt":"$CHAT_DATE"}"""
                            if (unconfirmed) {
                                readsAfterWrite.incrementAndGet()
                                if (releaseUnconfirmedEvent.get()) original else ""
                            } else {
                                readStarted.countDown()
                                check(releaseRead.await(45, TimeUnit.SECONDS))
                                "$original," +
                                    """{"id":"$laterEventId","seqId":2,"projectId":"$CHAT_PROJECT","kind":"renamed","name":"$confirmedName","createdAt":"$CHAT_DATE"}"""
                            }
                        } else ""
                    jsonResponse("""{"events":[$rows],"hasMore":false}""")
                }
                val renamePath =
                    if (project) "/api/projects/$CHAT_PROJECT" else "/api/chat-threads/$CHAT_PERSONAL/rename"
                fixture.commandResponse = { request ->
                    if (request.requestUrl?.encodedPath != renamePath) null
                    else {
                        val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                        val field = if (project) "name" else "title"
                        check(body.getValue(field).jsonPrimitive.content == newName)
                        writes.incrementAndGet()
                        if (rejectFirstWrite.getAndSet(false)) MockResponse().setResponseCode(400)
                        else {
                            writeStarted.countDown()
                            check(releaseWrite.await(45, TimeUnit.SECONDS))
                            operation.set(body.getValue("eventId").jsonPrimitive.content)
                            if (project && !unconfirmed) {
                                jsonResponse("""{"id":"$CHAT_PROJECT","name":"$confirmedName","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE","sortOrder":"a0"}""")
                            } else MockResponse().setResponseCode(if (unconfirmed) 503 else 204)
                        }
                    }
                }
                app.chatService = fixture.service
                app.workflows = fixture.service.workflowService
                app.connectorService = fixture.service.connectors
                if (project) {
                    device.executeShellCommand("wm size 1180x920")
                    device.executeShellCommand("wm density 160")
                }
                auth.state.value = testAuthenticationState(user = "rename-${UUID.randomUUID()}")
                val heading = labels.getString(if (project) R.string.chat_rename_project else R.string.chat_rename)
                val menu = labels.getString(if (project) R.string.chat_rename_confirm else R.string.chat_rename)
                fun snapshotName(scenario: ActivityScenario<MainActivity>, expected: String) {
                    scenario.onActivity { activity ->
                        val model = ViewModelProvider(activity)[SessionModel::class.java]
                        val list = checkNotNull(model.uiState.value.ready).chats.uiState.value
                        val actual =
                            if (project) list.projects.single { it.id == CHAT_PROJECT }.name
                            else list.threads.single { it.id == CHAT_PERSONAL }.title
                        check(actual == expected) { "Expected $expected, found $actual" }
                    }
                }
                try {
                    ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                        var minimumFieldHeight = 0
                        scenario.onActivity { activity ->
                            val configuration = activity.resources.configuration
                            check((configuration.screenWidthDp >= 720) == project)
                            minimumFieldHeight = (56 * activity.resources.displayMetrics.density).roundToInt()
                        }
                        device.find(By.pkg(app.packageName).text(oldName)).longClick()
                        device.find(By.pkg(app.packageName).text(menu)).click()
                        val focusedEditor = By.pkg(app.packageName).clazz("android.widget.EditText").focused(true)
                        val input = device.find(focusedEditor)
                        check(input.visibleBounds.height() >= minimumFieldHeight) {
                            "Rename input is below the 56 dp minimum"
                        }
                        input.text = newName
                        val save = By.pkg(app.packageName).text(labels.getString(R.string.chat_project_rename_save)).enabled(true)
                        if (project && !unconfirmed) {
                            device.find(save).click()
                            device.find(By.pkg(app.packageName).text(labels.getString(R.string.chat_rename_save_failed)))
                            check(device.find(focusedEditor).text == newName)
                            device.find(save)
                            snapshotName(scenario, oldName)
                            ScreenshotCapture.capture("$prefix-rejected.png")
                        }
                        device.find(save).click()
                        check(writeStarted.await(10, TimeUnit.SECONDS))
                        device.find(By.pkg(app.packageName).text(labels.getString(R.string.settings_saving)))
                        snapshotName(scenario, oldName)
                        if (unconfirmed) {
                            releaseWrite.countDown()
                            val panel = By.pkg(app.packageName).text(heading)
                            val checkLabel = labels.getString(R.string.chat_rename_check_result)
                            val checkResult = By.pkg(app.packageName).text(checkLabel).enabled(true)
                            device.find(checkResult)
                            val priorReads = readsAfterWrite.get()
                            device.find(checkResult).click()
                            check(
                                device.wait(
                                    object : Condition<UiDevice, Boolean> {
                                        override fun apply(device: UiDevice): Boolean =
                                            readsAfterWrite.get() > priorReads && device.hasObject(checkResult)
                                    },
                                    12_000,
                                ),
                            )
                            snapshotName(scenario, oldName)
                            val cancel = labels.getString(R.string.chat_rename_cancel)
                            device.find(By.pkg(app.packageName).text(cancel)).click()
                            check(device.wait(Until.gone(panel), 12_000))
                            if (project) {
                                device.find(By.pkg(app.packageName).text(labels.getString(R.string.chat_project_rename_unconfirmed)))
                                check(!device.hasObject(By.pkg(app.packageName).text(labels.getString(R.string.retry))))
                                ScreenshotCapture.capture("wide-project-unconfirmed-row.png")
                            }
                            device.find(By.pkg(app.packageName).text(oldName)).longClick()
                            device.find(By.pkg(app.packageName).text(menu)).click()
                            device.find(checkResult)
                            check(device.find(focusedEditor).text == newName)
                            device.find(By.pkg(app.packageName).text(labels.getString(R.string.chat_rename_save_unconfirmed)))
                            ScreenshotCapture.capture(
                                if (project) "wide-project-check-result.png" else "phone-chat-unconfirmed.png",
                            )
                            releaseUnconfirmedEvent.set(true)
                            device.find(checkResult).click()
                            check(device.wait(Until.gone(panel), 12_000))
                            device.find(By.pkg(app.packageName).text(confirmedName))
                            val success = if (project) R.string.chat_project_name_saved else R.string.chat_title_saved
                            device.find(By.pkg(app.packageName).text(labels.getString(success)))
                            snapshotName(scenario, confirmedName)
                            check(writes.get() == 1)
                            if (!project) ScreenshotCapture.capture("phone-chat-confirmed-after-later-rename.png")
                            return@use
                        }
                        ScreenshotCapture.capture("$prefix-saving.png")

                        releaseWrite.countDown()
                        check(readStarted.await(12, TimeUnit.SECONDS))
                        check(device.wait(Until.gone(By.pkg(app.packageName).text(heading)), 12_000))
                        device.find(By.pkg(app.packageName).text(confirmedName))
                        val success = if (project) R.string.chat_project_name_saved else R.string.chat_title_saved
                        device.find(By.pkg(app.packageName).text(labels.getString(success)))
                        snapshotName(scenario, confirmedName)
                        ScreenshotCapture.capture("$prefix-confirmed.png")
                        if (!project) {
                            val search = labels.getString(R.string.chat_search_workspace)
                            device.find(By.pkg(app.packageName).desc(search)).click()
                            device.find(focusedEditor)
                            device.find(By.pkg(app.packageName).text(newName)).click()
                            device.find(By.pkg(app.packageName).text("Hello history"))
                            device.find(By.pkg(app.packageName).text(newName))
                        }
                        releaseRead.countDown()
                    }
                } finally {
                    releaseWrite.countDown()
                    releaseRead.countDown()
                    fixture.close()
                }
            }
        } finally {
            auth.state.value = originalAuth
            app.chatService = originalChat
            app.workflows = originalWorkflows
            app.connectorService = originalConnectors
            app.restoreApiPreferences(originalPreferences)
            app.initialPreferences = originalInitialPreferences
            instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocale }
            device.executeShellCommand("wm size ${originalSize ?: "reset"}")
            device.executeShellCommand("wm density ${originalDensity ?: "reset"}")
            device.restoreSetting("system", "font_scale", fontScale)
            device.restoreSetting("global", "animator_duration_scale", motionScale)
            cache.restore()
        }
    }

    private fun UiDevice.overrideValue(command: String, pattern: String) =
        Regex(pattern).find(executeShellCommand(command))?.groupValues?.get(1)

    private fun UiDevice.restoreSetting(namespace: String, name: String, value: String) {
        if (value == "null") executeShellCommand("settings delete $namespace $name")
        else executeShellCommand("settings put $namespace $name $value")
    }

    private fun UiDevice.find(selector: BySelector): UiObject2 =
        checkNotNull(wait(Until.findObject(selector), 12_000)) { "Missing $selector" }
}
