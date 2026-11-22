package ai.okou.android.workflows

import ai.okou.android.CHAT_DATE
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.CanonicalOptional
import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.WorkflowDetailVisibility
import ai.okou.android.api.generated.WorkflowSummary
import ai.okou.android.api.generated.WorkflowSummaryVisibility
import ai.okou.android.api.generated.WorkspaceWorkflowAutomations
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WorkflowModelTest {
    @Test
    fun cachedReadsBackOffIndependentlyAndOnlyWarnAfterSustainedFailure() =
        check { service, model ->
            model.select(service.summary.id)
            model.visibilityChanged(true)
            runCurrent()
            assertNotNull(model.state.value.catalog)
            assertNotNull(model.state.value.detail)

            val catalogAttempts = mutableListOf<Long>()
            service.catalogRead = {
                catalogAttempts += testScheduler.currentTime
                if (catalogAttempts.size <= 3) throw ApiFailure.Network(IOException("Offline"))
                listOf(service.summary)
            }
            model.visibilityChanged(false)
            model.visibilityChanged(true)
            runCurrent()

            advanceTimeBy(29_999)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L), catalogAttempts)
            assertEquals(listOf(service.summary), model.state.value.catalog)
            assertEquals(WorkflowReadFailure.CouldNotLoad, model.state.value.catalogFailure)
            assertNull(model.state.value.detailFailure)
            assertEquals(2, service.detailReads)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(WorkflowReadFailure.RefreshFailed, model.state.value.catalogFailure)
            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L, 35_000L), catalogAttempts)
            assertNull(model.state.value.catalogFailure)
            assertEquals(2, service.detailReads)
        }

    @Test
    fun successfulSaveRestartsInterruptedCatalogRead() = check { service, model ->
        var holdCatalog = true
        service.catalogRead = {
            if (holdCatalog) awaitCancellation()
            listOf(service.summary)
        }
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        assertNotNull(model.state.value.detail)
        assertNull(model.state.value.catalog)

        holdCatalog = false
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val edited = opened.copy(value = opened.value.copy(instruction = "Confirmed"))
        model.edit(edited)
        model.save(edited)
        runCurrent()

        assertEquals("Confirmed", model.state.value.detail?.instruction)
        assertEquals(listOf(service.summary), model.state.value.catalog)
        assertTrue(model.state.value.rules?.isEmpty() == true)
    }

    @Test
    fun instructionSaveUsesTheCurrentEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val opened = checkNotNull(model.state.value.detail).editableInstructions()
        val previous = opened.copy(value = opened.value.copy(instruction = "Older edit"))
        val current = opened.copy(value = opened.value.copy(instruction = "Current edit"))
        model.edit(previous)
        model.edit(current)
        model.save(previous)
        runCurrent()

        assertEquals(current, model.state.value.editor)
        assertNull(model.state.value.detail?.instruction)
        model.save(current)
        runCurrent()
        assertEquals("Current edit", model.state.value.detail?.instruction)
        assertNull(model.state.value.editor)
    }

    @Test
    fun uncertainCreationIgnoresAnotherSaveFromTheSameEditor() = check { service, model ->
        model.select(service.summary.id)
        model.visibilityChanged(true)
        runCurrent()
        val editor = WorkflowEdit.Rule(id = null, original = RuleFields(timezone = "UTC"))
        model.edit(editor)
        model.save(editor)
        runCurrent()

        assertEquals(WorkflowWriteIssue.UncertainCreate, model.state.value.issue)
        assertEquals(editor, model.state.value.editor)
        model.save(editor)
        runCurrent()
        assertEquals(1, service.createAttempts)
    }

    private fun check(action: suspend TestScope.(Service, WorkflowModel) -> Unit) = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val service = Service()
        val store = ViewModelStore()
        val model =
            ViewModelProvider(
                store,
                viewModelFactory {
                    initializer {
                        WorkflowModel(service, { true }, { throw it }) { testScheduler.currentTime }
                    }
                },
            )[WorkflowModel::class.java]
        try {
            action(service, model)
        } finally {
            store.clear()
            runCurrent()
            Dispatchers.resetMain()
        }
    }

    private class Service : WorkflowService {
        val summary =
            WorkflowSummary(
                id = "a1111111-1111-4111-8111-111111111111",
                name = "release-review",
                displayName = "Release review",
                description = null,
                visibility = WorkflowSummaryVisibility.PRIVATE,
                ownerUserId = "user-a",
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
            )
        private var detail =
            WorkflowDetail(
                id = summary.id,
                name = summary.name,
                displayName = summary.displayName,
                description = null,
                visibility = WorkflowDetailVisibility.PRIVATE,
                ownerUserId = summary.ownerUserId,
                createdAt = CHAT_DATE,
                canManage = true,
                canPublish = true,
                official = null,
                importSource = null,
                createdByUserId = summary.ownerUserId,
                updatedByUserId = summary.ownerUserId,
                updatedAt = CHAT_DATE,
                instruction = null,
                files = null,
                fileContents = null,
                automations = emptyList(),
            )
        var catalogRead: suspend () -> List<WorkflowSummary> = { listOf(summary) }
        var detailReads = 0
            private set

        var createAttempts = 0
            private set

        override suspend fun workflows() = catalogRead()

        override suspend fun workflow(id: String): WorkflowDetail {
            detailReads++
            return detail
        }

        override suspend fun workflowAutomations(): WorkspaceWorkflowAutomations = emptyList()

        override suspend fun workflowConnections(): Set<String> = emptySet()

        override suspend fun updateWorkflow(
            id: String,
            request: UpdateWorkflowRequest,
        ): WorkflowDetail {
            detail =
                detail.copy(instruction = (request.instruction as CanonicalOptional.Present).value)
            return detail
        }

        override suspend fun createAutomation(
            workflowId: String,
            request: CreateWorkflowAutomationRequest,
        ): Nothing {
            createAttempts++
            throw ApiFailure.Network(IOException("Automation response was lost"))
        }

        override suspend fun updateAutomation(
            id: String,
            request: UpdateWorkflowAutomationRequest,
        ) = error("Unexpected automation update")

        override suspend fun setAutomationEnabled(id: String, enabled: Boolean) =
            error("Unexpected automation toggle")
    }
}
