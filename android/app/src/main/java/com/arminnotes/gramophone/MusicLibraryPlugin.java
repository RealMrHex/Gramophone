package com.arminnotes.gramophone;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.provider.Settings;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;

/**
 * The phone's music library, read from Android's MediaStore.
 *
 *  - access(): is reading music allowed? request(): ask for it
 *    (READ_MEDIA_AUDIO on Android 13+, READ_EXTERNAL_STORAGE before that)
 *  - scan(): every song on the device (internal storage + SD card), with tags, duration and a content:// uri
 *    the web layer streams through Capacitor's local server (Capacitor.convertFileSrc)
 *  - artwork({ uri }): a small JPEG thumbnail of the song's cover, base64
 */
@CapacitorPlugin(
    name = "MusicLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MusicLibraryPlugin extends Plugin {

    private String alias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "storage";
    }

    private JSObject accessState() {
        PermissionState s = getPermissionState(alias());
        JSObject r = new JSObject();
        r.put("granted", s == PermissionState.GRANTED);
        // "prompt" | "prompt-with-rationale" | "denied" | "granted"
        r.put("state", s == null ? "prompt" : s.toString());
        return r;
    }

    @PluginMethod
    public void access(PluginCall call) {
        call.resolve(accessState());
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            call.resolve(accessState());
            return;
        }
        requestPermissionForAlias(alias(), call, "afterRequest");
    }

    @PermissionCallback
    private void afterRequest(PluginCall call) {
        call.resolve(accessState());
    }

    @PluginMethod
    public void scan(PluginCall call) {
        if (getPermissionState(alias()) != PermissionState.GRANTED) {
            call.reject("Music access hasn't been allowed", "NO_PERMISSION");
            return;
        }
        final long minMs = call.getLong("minDurationMs", 20000L);
        getBridge().execute(() -> {
            try {
                call.resolve(query(minMs));
            } catch (Exception e) {
                call.reject("Couldn't read the music library: " + e.getMessage(), "SCAN_FAILED", e);
            }
        });
    }

    private JSObject query(long minMs) {
        ContentResolver cr = getContext().getContentResolver();
        Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        boolean q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String[] projection = {
            MediaStore.Audio.Media._ID,
            MediaStore.Audio.Media.TITLE,
            MediaStore.Audio.Media.ARTIST,
            MediaStore.Audio.Media.ALBUM,
            MediaStore.Audio.Media.DURATION,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE,
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.DATE_ADDED,
            q ? MediaStore.Audio.Media.RELATIVE_PATH : MediaStore.Audio.Media.DATA,
        };
        // Songs: anything flagged as music, or any audio that isn't a ringtone / notification / alarm sound. Some phones
        // leave IS_MUSIC or DURATION empty for files they haven't fully indexed, so those aren't excluded either;
        // only clips known to be short are.
        String selection = "(" + MediaStore.Audio.Media.IS_MUSIC + " != 0 OR (" + MediaStore.Audio.Media.IS_RINGTONE + " = 0 AND "
            + MediaStore.Audio.Media.IS_NOTIFICATION + " = 0 AND " + MediaStore.Audio.Media.IS_ALARM + " = 0)) AND ("
            + MediaStore.Audio.Media.DURATION + " IS NULL OR " + MediaStore.Audio.Media.DURATION + " = 0 OR "
            + MediaStore.Audio.Media.DURATION + " >= ?)";
        String[] args = { String.valueOf(minMs) };
        long t0 = System.currentTimeMillis();
        int totalAudio = -1;
        try (Cursor all = cr.query(collection, new String[] { MediaStore.Audio.Media._ID }, null, null, null)) {
            if (all != null) totalAudio = all.getCount();
        } catch (Exception ignored) { }

        JSArray songs = new JSArray();
        try (Cursor c = cr.query(collection, projection, selection, args, MediaStore.Audio.Media.DATE_ADDED + " DESC")) {
            if (c != null) {
                int iId = c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                int iTitle = c.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                int iArtist = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                int iAlbum = c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                int iDur = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                int iSize = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                int iMime = c.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
                int iName = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                int iAdded = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_ADDED);
                int iPath = c.getColumnIndexOrThrow(q ? MediaStore.Audio.Media.RELATIVE_PATH : MediaStore.Audio.Media.DATA);
                while (c.moveToNext()) {
                    long id = c.getLong(iId);
                    JSObject s = new JSObject();
                    s.put("id", id);
                    s.put("uri", ContentUris.withAppendedId(collection, id).toString());
                    s.put("title", clean(c.getString(iTitle)));
                    s.put("artist", clean(c.getString(iArtist)));
                    s.put("album", clean(c.getString(iAlbum)));
                    s.put("duration", c.getLong(iDur) / 1000.0);
                    s.put("size", c.getLong(iSize));
                    s.put("mime", c.getString(iMime));
                    s.put("name", c.getString(iName));
                    s.put("added", c.getLong(iAdded));
                    s.put("folder", c.getString(iPath));
                    songs.put(s);
                }
            }
        }
        JSObject r = new JSObject();
        r.put("songs", songs);
        // for diagnostics reports: how much audio Android knows about vs. how much looked like songs
        JSObject stats = new JSObject();
        stats.put("totalAudio", totalAudio);
        stats.put("matched", songs.length());
        stats.put("ms", System.currentTimeMillis() - t0);
        stats.put("volumes", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? MediaStore.getExternalVolumeNames(getContext()).toString() : "external");
        r.put("stats", stats);
        return r;
    }

    /** device + app facts for diagnostics reports (no personal data) */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("model", Build.MODEL);
        r.put("device", Build.DEVICE);
        r.put("android", Build.VERSION.RELEASE);
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("permission", accessState().getString("state"));
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("appVersion", pi.versionName);
            r.put("appBuild", Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode);
        } catch (Exception ignored) { }
        try {
            PackageInfo wv = Build.VERSION.SDK_INT >= 26 ? android.webkit.WebView.getCurrentWebViewPackage() : null;
            if (wv != null) r.put("webview", wv.packageName + " " + wv.versionName);
        } catch (Exception ignored) { }
        call.resolve(r);
    }

    /** Android's app-info screen (to turn music access back on after "Don't allow") */
    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** the system share sheet with some text (diagnostics reports → Telegram, email, …) */
    @PluginMethod
    public void share(PluginCall call) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_SUBJECT, call.getString("title", "Gramophone report"));
        send.putExtra(Intent.EXTRA_TEXT, call.getString("text", ""));
        Intent chooser = Intent.createChooser(send, call.getString("title", "Share report"));
        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(chooser);
        call.resolve();
    }

    /** MediaStore fills unknown tags with "<unknown>" */
    private static String clean(String s) {
        if (s == null) return "";
        String t = s.trim();
        return "<unknown>".equalsIgnoreCase(t) ? "" : t;
    }

    @PluginMethod
    public void artwork(PluginCall call) {
        String uri = call.getString("uri");
        int size = call.getInt("size", 256);
        if (uri == null) {
            call.reject("uri is required");
            return;
        }
        getBridge().execute(() -> {
            JSObject r = new JSObject();
            try {
                Bitmap bmp = null;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    bmp = getContext().getContentResolver().loadThumbnail(Uri.parse(uri), new Size(size, size), null);
                } else {
                    android.media.MediaMetadataRetriever mmr = new android.media.MediaMetadataRetriever();
                    try {
                        mmr.setDataSource(getContext(), Uri.parse(uri));
                        byte[] art = mmr.getEmbeddedPicture();
                        if (art != null) bmp = android.graphics.BitmapFactory.decodeByteArray(art, 0, art.length);
                    } finally {
                        mmr.release();
                    }
                }
                if (bmp != null) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 86, out);
                    r.put("jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                }
            } catch (Exception ignored) {
                // no embedded cover — that's fine
            }
            call.resolve(r);
        });
    }
}
