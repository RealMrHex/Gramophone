package com.arminnotes.gramophone;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The web app's line to Android's media controls (notification, lock screen, quick settings, headset buttons).
 *
 *  update({ title, artist, album, artwork?, duration, position, playing, canPrev, canNext })   artwork = base64 JPEG
 *  clear()
 *  event "action": { action: "play" | "pause" | "next" | "prev" | "seek", position? }
 */
@CapacitorPlugin(name = "MediaControls")
public class MediaControlsPlugin extends Plugin {

    @Override
    public void load() {
        MediaHub.init(getContext(), (action, pos) -> {
            JSObject e = new JSObject();
            e.put("action", action);
            if (pos >= 0) e.put("position", pos);
            notifyListeners("action", e, true);
        });
    }

    @PluginMethod
    public void update(PluginCall call) {
        String art64 = call.getString("artwork");
        Bitmap art = null;
        boolean artChanged = art64 != null;
        if (art64 != null && !art64.isEmpty()) {
            try {
                byte[] b = Base64.decode(art64, Base64.DEFAULT);
                art = BitmapFactory.decodeByteArray(b, 0, b.length);
            } catch (Exception ignored) { }
        }
        MediaHub.update(
            call.getString("title", ""), call.getString("artist", ""), call.getString("album", "Gramophone"),
            art, call.getDouble("duration", 0.0), call.getDouble("position", 0.0),
            Boolean.TRUE.equals(call.getBoolean("playing", false)),
            Boolean.TRUE.equals(call.getBoolean("canPrev", true)), Boolean.TRUE.equals(call.getBoolean("canNext", true)),
            artChanged);
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        MediaHub.clear();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        MediaHub.clear();
    }
}
