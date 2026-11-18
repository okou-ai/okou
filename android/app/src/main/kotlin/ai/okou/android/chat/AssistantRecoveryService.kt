package ai.okou.android.chat

import ai.okou.android.api.generated.RecoveryBilling
import ai.okou.android.api.generated.RecoveryCatalog
import ai.okou.android.api.generated.RecoveryModels
import ai.okou.android.api.generated.RecoverySubscriptions
import ai.okou.android.api.generated.ResetSubscriptionResult

interface AssistantRecoveryService {
    suspend fun recoveryCatalog(): RecoveryCatalog

    suspend fun recoveryModels(): RecoveryModels

    suspend fun recoverySubscriptions(): RecoverySubscriptions

    suspend fun recoveryBilling(): RecoveryBilling

    suspend fun resetSubscription(
        accountId: String,
        idempotencyKey: String,
    ): ResetSubscriptionResult
}
