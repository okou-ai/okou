package ai.okou.android

import ai.okou.android.api.generated.RecoveryBilling
import ai.okou.android.api.generated.RecoveryCatalog
import ai.okou.android.api.generated.RecoveryModels
import ai.okou.android.api.generated.RecoverySubscriptions
import ai.okou.android.api.generated.ResetSubscriptionResult
import ai.okou.android.chat.AssistantRecoveryService

class TestAssistantRecoveryService : AssistantRecoveryService {
    override suspend fun recoveryCatalog(): RecoveryCatalog =
        error("No recovery backend in this fixture")

    override suspend fun recoveryModels(): RecoveryModels =
        error("No recovery backend in this fixture")

    override suspend fun recoverySubscriptions(): RecoverySubscriptions =
        error("No recovery backend in this fixture")

    override suspend fun recoveryBilling(): RecoveryBilling =
        error("No recovery backend in this fixture")

    override suspend fun resetSubscription(
        accountId: String,
        idempotencyKey: String,
    ): ResetSubscriptionResult = error("No recovery backend in this fixture")
}
