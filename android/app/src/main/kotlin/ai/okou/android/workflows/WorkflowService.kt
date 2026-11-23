package ai.okou.android.workflows

import ai.okou.android.api.generated.CreateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowAutomationRequest
import ai.okou.android.api.generated.UpdateWorkflowRequest
import ai.okou.android.api.generated.WorkflowAutomation
import ai.okou.android.api.generated.WorkflowDetail
import ai.okou.android.api.generated.Workflows
import ai.okou.android.api.generated.WorkspaceWorkflowAutomations

interface WorkflowService {
    suspend fun workflows(): Workflows

    suspend fun workflow(id: String): WorkflowDetail

    suspend fun workflowAutomations(): WorkspaceWorkflowAutomations

    suspend fun workflowConnections(): Set<String>

    suspend fun updateWorkflow(id: String, request: UpdateWorkflowRequest): WorkflowDetail

    suspend fun createAutomation(
        workflowId: String,
        request: CreateWorkflowAutomationRequest,
    ): WorkflowAutomation

    suspend fun updateAutomation(
        id: String,
        request: UpdateWorkflowAutomationRequest,
    ): WorkflowAutomation

    suspend fun setAutomationEnabled(id: String, enabled: Boolean): WorkflowAutomation
}

internal suspend fun WorkflowService.workspaceCatalog() = workflows().filter { it.official == null }
