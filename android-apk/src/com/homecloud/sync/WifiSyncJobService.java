package com.homecloud.sync;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.provider.MediaStore;

public class WifiSyncJobService extends JobService {
    private static final int JOB_ID_MEDIA_TRIGGER = 101;
    private static final int JOB_ID_PERIODIC_WIFI = 102;

    @Override
    public boolean onStartJob(final JobParameters params) {
        final int jobId = params.getJobId();
        SyncEngine.startAsyncSync(getApplicationContext(), false, new Runnable() {
            @Override
            public void run() {
                if (jobId == JOB_ID_MEDIA_TRIGGER) {
                    // Re-arm content trigger for future photos
                    scheduleMediaTriggerJob(getApplicationContext());
                }
                jobFinished(params, false);
            }
        });
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true; // Reschedule if Wi-Fi dropped mid-sync
    }

    public static void scheduleAllBackgroundJobs(Context ctx) {
        scheduleMediaTriggerJob(ctx);
        schedulePeriodicWifiJob(ctx);
    }

    public static void scheduleMediaTriggerJob(Context ctx) {
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            ComponentName cn = new ComponentName(ctx, WifiSyncJobService.class);
            JobInfo.Builder b = new JobInfo.Builder(JOB_ID_MEDIA_TRIGGER, cn)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .addTriggerContentUri(new JobInfo.TriggerContentUri(
                    MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                    JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS
                ))
                .addTriggerContentUri(new JobInfo.TriggerContentUri(
                    MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
                    JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS
                ))
                .setTriggerContentUpdateDelay(2000L)
                .setTriggerContentMaxDelay(10000L);
            js.schedule(b.build());
        } catch (Exception ignored) {}
    }

    public static void schedulePeriodicWifiJob(Context ctx) {
        try {
            JobScheduler js = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            ComponentName cn = new ComponentName(ctx, WifiSyncJobService.class);
            JobInfo.Builder b = new JobInfo.Builder(JOB_ID_PERIODIC_WIFI, cn)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
                .setPersisted(true)
                .setPeriodic(15 * 60 * 1000L);
            js.schedule(b.build());
        } catch (Exception ignored) {}
    }
}
