package com.arminnotes.gramophone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

/**
 * Gramophone's presence outside the app: one MediaSession plus its media-style notification.
 *
 * Android builds the lock-screen player, the quick-settings media card and the notification controls from this
 * session (title, artist, cover, duration, position, which buttons exist). Button presses come back through the
 * session callback (Android 13+) or the notification's own actions (older versions) and are forwarded to the web
 * app, which does the actual playing.
 */
final class MediaHub {
    interface Listener { void onAction(String action, double positionSec); }

    static final String CHANNEL = "playback";
    static final int NOTIFICATION_ID = 33;
    static final String ACTION_PLAY = "gramophone.PLAY", ACTION_PAUSE = "gramophone.PAUSE",
        ACTION_NEXT = "gramophone.NEXT", ACTION_PREV = "gramophone.PREV", ACTION_STOP = "gramophone.STOP";

    private static Context app;
    private static MediaSessionCompat session;
    private static Listener listener;

    // what's showing now
    private static String title = "", artist = "";
    private static Bitmap art;
    private static boolean playing, canPrev, canNext, visible;

    static void init(Context ctx, Listener l) {
        listener = l;
        if (session != null) return;
        app = ctx.getApplicationContext();
        session = new MediaSessionCompat(app, "Gramophone");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { emit("play", -1); }
            @Override public void onPause() { emit("pause", -1); }
            @Override public void onSkipToNext() { emit("next", -1); }
            @Override public void onSkipToPrevious() { emit("prev", -1); }
            @Override public void onStop() { emit("pause", -1); }
            @Override public void onSeekTo(long pos) { emit("seek", pos / 1000.0); }
        });
        // tapping the player on the lock screen / in quick settings opens the app
        session.setSessionActivity(openApp());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Playback controls for the song on the record");
            ch.setShowBadge(false);
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            app.getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    static void emit(String action, double pos) { if (listener != null) listener.onAction(action, pos); }

    /** handle a notification button (pre-Android 13 path); the session callback covers newer versions */
    static void dispatch(String action) {
        if (ACTION_PLAY.equals(action)) emit("play", -1);
        else if (ACTION_PAUSE.equals(action)) emit("pause", -1);
        else if (ACTION_NEXT.equals(action)) emit("next", -1);
        else if (ACTION_PREV.equals(action)) emit("prev", -1);
        else if (ACTION_STOP.equals(action)) { emit("pause", -1); clear(); }
    }

    static void update(String t, String a, String album, Bitmap artwork, double durationSec, double positionSec,
                       boolean isPlaying, boolean prev, boolean next, boolean artChanged) {
        if (session == null) return;
        title = t; artist = a; playing = isPlaying; canPrev = prev; canNext = next;
        if (artChanged) art = artwork;

        MediaMetadataCompat.Builder m = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, t)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, a)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, t)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, a)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, (long) (durationSec * 1000));
        if (art != null) {
            m.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art);
            m.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, art);
            m.putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, art);
        }
        session.setMetadata(m.build());

        long actions = PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SEEK_TO | PlaybackStateCompat.ACTION_STOP;
        if (prev) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        if (next) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(isPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                (long) (positionSec * 1000), isPlaying ? 1f : 0f)
            .build());
        session.setActive(true);
        visible = true;

        Intent svc = new Intent(app, PlaybackService.class).setAction(PlaybackService.ACTION_SHOW);
        if (isPlaying) {
            // keep the app alive in the background while music plays
            try { ContextCompat.startForegroundService(app, svc); }
            catch (Exception e) { post(); } // not allowed right now (background start limits): just show it
        } else {
            PlaybackService.leaveForeground();
            post();
        }
    }

    static void post() {
        if (!visible || app == null) return;
        try { NotificationManagerCompat.from(app).notify(NOTIFICATION_ID, build()); }
        catch (SecurityException ignored) { /* notifications turned off for the app */ }
    }

    static void clear() {
        visible = false;
        if (session != null) {
            session.setPlaybackState(new PlaybackStateCompat.Builder().setState(PlaybackStateCompat.STATE_STOPPED, 0, 0f).build());
            session.setActive(false);
        }
        PlaybackService.leaveForeground();
        if (app != null) {
            NotificationManagerCompat.from(app).cancel(NOTIFICATION_ID);
            app.stopService(new Intent(app, PlaybackService.class));
        }
    }

    /** the media-style notification — Android also renders the lock screen + quick-settings player from it */
    static Notification build() {
        androidx.media.app.NotificationCompat.MediaStyle style = new androidx.media.app.NotificationCompat.MediaStyle()
            .setMediaSession(session.getSessionToken())
            .setShowActionsInCompactView(0, 1, 2)
            .setShowCancelButton(true)
            .setCancelButtonIntent(control(ACTION_STOP));
        return new NotificationCompat.Builder(app, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_gramophone)
            .setContentTitle(title)
            .setContentText(artist.isEmpty() ? "Gramophone" : artist)
            .setSubText("Gramophone")
            .setLargeIcon(art)
            .setContentIntent(openApp())
            .setDeleteIntent(control(ACTION_STOP))
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setColor(0xFFFF7A59)          // the app's coral accent (tints the icon + background on older Androids)
            .setColorized(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setOngoing(playing)
            .addAction(R.drawable.ic_media_prev, "Previous", canPrev ? control(ACTION_PREV) : null)
            .addAction(playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play, playing ? "Pause" : "Play",
                control(playing ? ACTION_PAUSE : ACTION_PLAY))
            .addAction(R.drawable.ic_media_next, "Next", canNext ? control(ACTION_NEXT) : null)
            .setStyle(style)
            .build();
    }

    private static PendingIntent control(String action) {
        Intent i = new Intent(app, PlaybackService.class).setAction(action);
        return PendingIntent.getService(app, action.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openApp() {
        Intent i = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        if (i == null) i = new Intent(app, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(app, 1, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
