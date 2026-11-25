package ma.sonicod.operations

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/** Synchronise automatiquement les opérations hors ligne dès que le réseau revient. */
class SyncWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {

    override fun doWork(): Result {
        if (OpQueue.list(applicationContext).isEmpty()) return Result.success()
        return if (Submitter.flushQueue(applicationContext)) Result.success() else Result.retry()
    }

    companion object {
        fun schedule(ctx: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(ctx).enqueueUniqueWork("sonicod-sync", ExistingWorkPolicy.REPLACE, request)
        }
    }
}
