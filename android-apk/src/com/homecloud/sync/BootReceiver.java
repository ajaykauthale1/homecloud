package com.homecloud.sync;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        WifiSyncJobService.scheduleAllBackgroundJobs(context);
        SyncEngine.startAsyncSync(context, false, null);
    }
}
