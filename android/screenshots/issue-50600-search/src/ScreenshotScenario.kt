package ai.okou.android.screenshots

import ai.okou.android.ArtifactApiFixture
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestOkouApplication
import ai.okou.android.WorkflowApiFixture
import ai.okou.android.awaitChatList
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.util.UUID
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun searchInputs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val authentication = app.authentication as TestAuthentication
        val savedAuth = authentication.state.value
        val savedChats = app.chatService
        val savedWorkflows = app.workflows
        val savedConnectors = app.connectorService
        val savedPreferences = app.snapshotApiPreferences()
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val failures = mutableListOf<Throwable>()
        try {
            WorkflowApiFixture().use { workflows ->
                ConnectorApiFixture().use { connectors ->
                    val artifacts = ArtifactApiFixture(workflows.chats)
                    artifacts.install()
                    app.chatService = workflows.service
                    app.workflows = workflows.service
                    app.connectorService = connectors.service
                    authentication.state.value =
                        testAuthenticationState(user = "search-fields-${UUID.randomUUID()}")
                    ActivityScenario.launch(MainActivity::class.java).use {
                        fun description(label: Int) =
                            By.pkg(app.packageName).desc(app.getString(label)).enabled(true)

                        fun text(label: String) = By.pkg(app.packageName).textContains(label)

                        fun await(selector: BySelector) =
                            checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                                "Missing $selector"
                            }

                        fun capture(query: String, result: String, image: String, clearLabel: Int) {
                            fun editor() = By.pkg(app.packageName).clazz("android.widget.EditText")
                            val clear = description(clearLabel)
                            await(editor()).click()
                            await(editor().focused(true)).setText(query)
                            await(text(result))
                            await(clear)
                            ScreenshotCapture.capture(image)
                            await(clear).click()
                            check(device.wait(Until.gone(clear), 10_000)) {
                                "Clear remained visible"
                            }
                            await(editor().focused(true))
                        }

                        device.awaitChatList(app)
                        await(description(R.string.chat_search_workspace)).click()
                        capture(
                            "release",
                            artifacts.sourceTitle,
                            "workspace.png",
                            R.string.chat_search_clear,
                        )
                        await(description(R.string.back)).click()

                        device.awaitChatList(app)
                        await(text(artifacts.sourceTitle)).click()
                        val reply = "Native history reply"
                        await(text(reply))
                        await(description(R.string.chat_actions)).click()
                        await(text(app.getString(R.string.conversation_find))).click()
                        capture("Native history", reply, "find.png", R.string.chat_search_clear)
                        await(description(R.string.back)).click()
                        await(description(R.string.back)).click()

                        device.awaitChatList(app)
                        await(description(R.string.workspace_workflows)).click()
                        capture(
                            "Release",
                            workflows.releaseTitle,
                            "workflows.png",
                            R.string.workflow_clear_search,
                        )
                        await(description(R.string.back)).click()

                        device.awaitChatList(app)
                        await(description(R.string.workspace_connectors)).click()
                        capture(
                            "Calendar",
                            "Google Calendar",
                            "connectors.png",
                            R.string.connector_clear,
                        )
                        await(description(R.string.back)).click()

                        device.awaitChatList(app)
                        await(description(R.string.workspace_artifacts)).click()
                        capture(
                            "Product launch",
                            artifacts.summary.title,
                            "artifacts.png",
                            R.string.chat_search_clear,
                        )
                    }
                }
            }
        } catch (failure: Throwable) {
            failures += failure
        } finally {
            fun restore(action: () -> Unit) {
                try {
                    action()
                } catch (failure: Throwable) {
                    failures += failure
                }
            }
            restore {
                app.chatService = savedChats
                app.workflows = savedWorkflows
                app.connectorService = savedConnectors
                authentication.state.value = savedAuth
            }
            restore { app.restoreApiPreferences(savedPreferences) }
            restore { savedCache.restore() }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
