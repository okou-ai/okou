package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ChatListApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.AndroidUpdatesRelease
import ai.okou.android.api.generated.UserPreferencesLocale
import ai.okou.android.awaitChatList
import ai.okou.android.awaitKeyboardFocus
import ai.okou.android.chatEventWire
import ai.okou.android.chatListRegion
import ai.okou.android.jsonResponse
import ai.okou.android.testAuthenticationState
import ai.okou.android.testPreferences
import ai.okou.android.updates.AppUpdates
import ai.okou.android.updates.UpdateRecord
import ai.okou.android.updates.UpdateService
import ai.okou.android.updates.UpdateStore
import android.app.LocaleManager
import android.content.res.Configuration
import android.os.LocaleList
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun capturesCreationAndItsToolbar() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalChat = app.chatService
        val originalUpdate = app.updateOwner
        val originalOnline = app.connectivity.value
        val originalPreferences = app.snapshotApiPreferences()
        val originalInitialPreferences = app.initialPreferences
        val localeManager = checkNotNull(app.getSystemService(LocaleManager::class.java))
        val originalLocale = localeManager.applicationLocales
        val locales = LocaleList.forLanguageTags("zh-Hans")
        val labels = app.createConfigurationContext(Configuration(app.resources.configuration).apply { setLocales(locales) })
        val cache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val originalSize = Regex("Override size: (\\d+x\\d+)").find(device.executeShellCommand("wm size"))?.groupValues?.get(1)
        val originalDensity = Regex("Override density: (\\d+)").find(device.executeShellCommand("wm density"))?.groupValues?.get(1)
        val originalFont = device.executeShellCommand("settings get system font_scale").trim()
        val originalIme = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        val originalMotion = device.executeShellCommand("settings get global animator_duration_scale").trim()
        val fixture = ChatListApiFixture()
        val committed = AtomicReference<String?>()
        val writeStarted = CountDownLatch(1)
        val releaseWrite = CountDownLatch(1)
        val updateAvailable = AtomicBoolean(false)
        val personal = "制定下周计划"
        val projectName = "产品研究"
        val reply = "我会先列出本周的重点，再确认下周的安排。"
        fixture.historyReply = reply
        fixture.events = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
            val event = chatEventWire("77777777-7777-4777-8777-000000000017", 17, CHAT_PERSONAL, title = personal)
            jsonResponse("""{"events":[${if (since < 17) event else ""}],"hasMore":false}""")
        }
        fixture.indicators = { jsonResponse("""{"threads":{},"unreadAt":{}}""") }
        fixture.projects = { jsonResponse("""{"projects":[],"latestEventId":null,"latestSeqId":0}""") }
        fixture.projectEvents = { request ->
            val since = request.requestUrl?.queryParameter("sinceSeqId")?.toLongOrNull() ?: 0L
            val id = committed.get()
            val event =
                if (id != null && since == 0L)
                    """{"id":"$id","seqId":1,"projectId":"$id","kind":"created","name":"$projectName","sortOrder":"a0","createdAt":"$CHAT_DATE"}"""
                else ""
            jsonResponse("""{"events":[$event],"hasMore":false}""")
        }
        fixture.commandResponse = { request ->
            if (request.method == "POST" && request.path == "/api/projects") {
                val body = Json.parseToJsonElement(request.body.clone().readUtf8()).jsonObject
                val id = body.getValue("id").jsonPrimitive.content
                check(id == body.getValue("eventId").jsonPrimitive.content)
                check(body.getValue("name").jsonPrimitive.content == projectName)
                writeStarted.countDown()
                check(releaseWrite.await(30, TimeUnit.SECONDS))
                committed.set(id)
                jsonResponse("""{"id":"$id","name":"$projectName","sortOrder":"a0","createdAt":"$CHAT_DATE","updatedAt":"$CHAT_DATE"}""").setResponseCode(201)
            } else null
        }
        val update =
            AppUpdates(
                object : UpdateService {
                    override suspend fun initialize(retainedRelease: AndroidUpdatesRelease?) = Unit
                    override suspend fun check(): AndroidUpdates =
                        AndroidUpdates(
                            null,
                            if (updateAvailable.get())
                                AndroidUpdatesRelease("99.0.0", 24, 1_000, "a".repeat(64), "https://static.okou.io/android-updates/releases/99.0.0/${"a".repeat(64)}.apk", "")
                            else null,
                        )
                    override suspend fun recover(release: AndroidUpdatesRelease): File? = null
                    override suspend fun download(release: AndroidUpdatesRelease, progress: (Long) -> Unit): File =
                        error("Unexpected update download")
                    override fun close() = Unit
                },
                object : UpdateStore {
                    override suspend fun load(): UpdateRecord? = null
                    override suspend fun save(record: UpdateRecord) = Unit
                },
                BuildConfig.VERSION_NAME,
                35,
            )
        fun text(id: Int) = By.pkg(app.packageName).text(labels.getString(id))
        fun description(id: Int) = By.pkg(app.packageName).desc(labels.getString(id))
        fun label(value: String) = By.pkg(app.packageName).text(value)
        fun find(selector: BySelector) = device.await(selector)
        fun openMore() = find(description(R.string.chat_more_actions)).click()
        fun openCreate() {
            openMore()
            find(text(R.string.chat_project_create)).click()
        }
        val field = By.pkg(app.packageName).clazz("android.widget.EditText")
        fun imeVisible() = instrumentation.uiAutomation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
        fun awaitIme(visible: Boolean) =
            device.awaitCondition("IME visible=$visible") { imeVisible() == visible }
        val failures = mutableListOf<Throwable>()
        try {
            device.executeShellCommand("wm size 440x900")
            device.executeShellCommand("wm density 160")
            device.executeShellCommand("settings put system font_scale 1.0")
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
            device.executeShellCommand("settings put global animator_duration_scale 0")
            app.chatService = fixture.service
            app.updateOwner = update
            app.connectivity.value = true
            app.initialPreferences = testPreferences().copy(locale = UserPreferencesLocale.ZH_HANS)
            auth.state.value = testAuthenticationState(user = "project-creation-${UUID.randomUUID()}")
            instrumentation.runOnMainSync { localeManager.applicationLocales = locales }
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                device.awaitChatList(labels)
                find(label(personal))
                openMore()
                val create = find(text(R.string.chat_project_create))
                check(create.visibleBounds.top < find(text(R.string.settings)).visibleBounds.top)
                check(!device.hasObject(text(R.string.chat_filter)))
                ScreenshotCapture.capture("phone-more.png")
                device.pressBack()

                updateAvailable.set(true)
                instrumentation.runOnMainSync { update.check() }
                find(description(R.string.updates_toolbar))
                openMore()
                check(find(text(R.string.chat_filter)).visibleBounds.top < find(text(R.string.chat_project_create)).visibleBounds.top)
                check(find(text(R.string.chat_project_create)).visibleBounds.top < find(text(R.string.settings)).visibleBounds.top)
                ScreenshotCapture.capture("phone-update-more.png")
                find(text(R.string.chat_project_create)).click()
                find(field).click()
                awaitIme(true)
                ScreenshotCapture.capture("phone-name.png")
                device.pressBack()
                awaitIme(false)
                find(text(R.string.chat_rename_cancel)).click()

                device.executeShellCommand("wm size 1180x920")
                device.awaitWindow(scenario) { it.screenWidthDp >= 1100 }
                device.awaitChatList(labels)
                find(label(personal)).click()
                find(label(reply))
                openCreate()
                find(field).setText(projectName)
                if (imeVisible()) {
                    device.pressBack()
                    awaitIme(false)
                }
                val button = find(text(R.string.chat_project_create_confirm)).button()
                val before = button.visibleBounds
                button.click()
                check(writeStarted.await(10, TimeUnit.SECONDS))
                val pending = find(text(R.string.chat_project_creating)).button()
                check(!pending.isEnabled)
                check(before.centerX() == pending.visibleBounds.centerX() && before.centerY() == pending.visibleBounds.centerY())
                ScreenshotCapture.capture("wide-creating.png")
                instrumentation.setInTouchMode(false)
                releaseWrite.countDown()
                find(label(projectName))
                device.awaitKeyboardFocus(label(projectName))
                find(text(R.string.composer_new_project))
                find(label(reply))
                ScreenshotCapture.capture("wide-created.png")

                device.executeShellCommand("wm size 850x440")
                device.executeShellCommand("settings put system font_scale 2.0")
                device.awaitWindow(scenario) { it.screenHeightDp < 480 && it.fontScale >= 2f }
                if (!device.hasObject(chatListRegion(labels))) device.pressBack()
                device.awaitChatList(labels)
                openCreate()
                find(field).click()
                awaitIme(true)
                find(field).setText("访谈计划")
                val action = text(R.string.chat_project_create_confirm)
                if (!device.hasObject(action)) {
                    val panel = find(By.pkg(app.packageName).scrollable(true).hasDescendant(field))
                    checkNotNull(panel.scrollUntil(Direction.DOWN, Until.findObject(action)))
                }
                check(find(action).isEnabled)
                ScreenshotCapture.capture("short-name.png")
            }
        } catch (failure: Throwable) {
            failures += failure
        } finally {
            releaseWrite.countDown()
            for (cleanup in listOf<() -> Unit>(
                { fixture.close() },
                { update.close() },
                { cache.restore() },
                { app.restoreApiPreferences(originalPreferences) },
                { app.initialPreferences = originalInitialPreferences },
                { app.chatService = originalChat },
                { app.updateOwner = originalUpdate },
                { app.connectivity.value = originalOnline },
                { auth.state.value = originalAuth },
                { instrumentation.runOnMainSync { localeManager.applicationLocales = originalLocale } },
                { instrumentation.setInTouchMode(true) },
                { device.executeShellCommand("wm size ${originalSize ?: "reset"}") },
                { device.executeShellCommand("wm density ${originalDensity ?: "reset"}") },
                { device.restoreSetting("system", "font_scale", originalFont) },
                { device.restoreSetting("secure", "show_ime_with_hard_keyboard", originalIme) },
                { device.restoreSetting("global", "animator_duration_scale", originalMotion) },
            )) {
                try {
                    cleanup()
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    private fun UiDevice.restoreSetting(namespace: String, name: String, original: String) {
        if (original == "null") executeShellCommand("settings delete $namespace $name")
        else executeShellCommand("settings put $namespace $name $original")
    }

    private fun UiDevice.await(selector: BySelector): UiObject2 =
        checkNotNull(wait(Until.findObject(selector), 10_000)) { "Missing $selector" }

    private fun UiObject2.button(): UiObject2 =
        checkNotNull(generateSequence(this) { it.parent }.firstOrNull { it.isClickable })

    private fun UiDevice.awaitCondition(description: String, ready: () -> Boolean) {
        val condition = object : Condition<UiDevice, Boolean> {
            override fun apply(device: UiDevice) = ready()
        }
        check(wait(condition, 10_000)) { "Expected $description" }
    }

    private fun UiDevice.awaitWindow(
        scenario: ActivityScenario<MainActivity>,
        ready: (Configuration) -> Boolean,
    ) = awaitCondition("the resized Activity") {
        var reached = false
        scenario.onActivity { reached = ready(it.resources.configuration) }
        reached
    }
}
