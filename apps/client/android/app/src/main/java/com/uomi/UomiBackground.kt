package com.uomi

import android.app.*
import android.content.*
import android.os.*
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.*
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class UomiRealtimeService : HeadlessJsTaskService() {
    companion object {
        @Volatile var running = false
    }

    private var started = false

    override fun onCreate() {
        super.onCreate()
        running = true
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26)
            manager.createNotificationChannel(
                NotificationChannel(
                    "uomi-realtime",
                    "Real-time audio sync",
                    NotificationManager.IMPORTANCE_LOW,
                )
            )
        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        val notification =
            (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "uomi-realtime")
                else Notification.Builder(this))
                .setContentTitle("Uomi · real-time sync")
                .setContentText("Connected audio is saved locally, then sent to your webhook.")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentIntent(open)
                .setOngoing(true)
                .build()
        startForeground(1, notification)
    }

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        if (started) return null
        started = true
        return HeadlessJsTaskConfig("UomiRealtime", Arguments.createMap(), 0, true)
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
    }
}

class UomiSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    companion object {
        @Volatile var taskSucceeded = false
    }

    override fun doWork(): Result {
        if (
            applicationContext.getSharedPreferences("uomi", 0).getString("mode", "manual") !=
                "periodic"
        )
            return Result.success()
        val host = (applicationContext as MainApplication).reactHost
        val finished = CountDownLatch(1)
        taskSucceeded = false
        var tasks: HeadlessJsTaskContext? = null
        var taskId = -1
        val listener =
            object : HeadlessJsTaskEventListener {
                override fun onHeadlessJsTaskStart(id: Int) {}

                override fun onHeadlessJsTaskFinish(id: Int) {
                    if (id == taskId) finished.countDown()
                }
            }
        return try {
            host.start().waitForCompletion()
            val context = host.currentReactContext ?: return Result.retry()
            tasks = HeadlessJsTaskContext.getInstance(context)
            val current = tasks
            UiThreadUtil.runOnUiThread {
                current.addTaskEventListener(listener)
                taskId =
                    current.startTask(
                        HeadlessJsTaskConfig("UomiSync", Arguments.createMap(), 480000, true)
                    )
            }
            if (finished.await(9, TimeUnit.MINUTES) && taskSucceeded) Result.success()
            else Result.retry()
        } catch (e: Exception) {
            Result.retry()
        } finally {
            tasks?.removeTaskEventListener(listener)
        }
    }
}
