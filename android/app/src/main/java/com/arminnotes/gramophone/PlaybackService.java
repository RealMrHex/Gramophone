package com.arminnotes.gramophone;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.ServiceCompat;

/**
 * Foreground "media playback" service: while a song plays it keeps Gramophone alive with the screen off or the app in
 * the background, and owns the now-playing notification. It also receives the notification's button presses.
 */
public class PlaybackService extends Service {
    static final String ACTION_SHOW = "gramophone.SHOW";
    private static PlaybackService running;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        running = this;
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_SHOW.equals(action)) {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
            try {
                ServiceCompat.startForeground(this, MediaHub.NOTIFICATION_ID, MediaHub.build(), type);
            } catch (Exception e) {
                MediaHub.post();
            }
        } else if (action != null) {
            MediaHub.dispatch(action);
        }
        return START_NOT_STICKY;
    }

    /** paused: the notification stays (and can be swiped away), but the app no longer pins itself in memory */
    static void leaveForeground() {
        if (running != null) ServiceCompat.stopForeground(running, ServiceCompat.STOP_FOREGROUND_DETACH);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // app swiped away from recents: the music (which lives in the app) is gone, so is its player
        MediaHub.clear();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
