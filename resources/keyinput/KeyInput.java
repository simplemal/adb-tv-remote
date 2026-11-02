import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.lang.reflect.Method;

/**
 * Injects input from stdin, one command per line: "press NAME", "down NAME", "long NAME" or
 * "up NAME" for keys, "touch down X Y", "touch move X Y" or "touch up X Y" for touches, in
 * screen pixels. "long" is the repeat a held key sends: without it apps never see a long press.
 * "shot" answers with a JPEG of the screen in base64, or "none" if the device has no such call.
 *
 * Runs on the device through app_process and stays alive, so a key costs milliseconds where
 * `input keyevent` starts a new JVM each time. Unlike monkey it does not use UiAutomation,
 * which would suspend the device's accessibility services.
 */
public final class KeyInput {
    private static final int INJECT_ASYNC = 0;
    private static final int SHOT_WIDTH = 960;
    private static final int SHOT_HEIGHT = 540;
    private static final int SHOT_QUALITY = 70;

    private final Object manager;
    private final Method inject;
    private long downTime;
    private long touchTime;

    private KeyInput() throws Exception {
        Class<?> type = Class.forName("android.hardware.input.InputManager");
        manager = type.getMethod("getInstance").invoke(null);
        inject = type.getMethod("injectInputEvent", InputEvent.class, int.class);
    }

    private void send(int action, int code) throws Exception {
        long now = SystemClock.uptimeMillis();
        if (action == KeyEvent.ACTION_DOWN) downTime = now;
        inject.invoke(manager, new KeyEvent(downTime, now, action, code, 0, 0,
            KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD), INJECT_ASYNC);
    }

    private void held(int code) throws Exception {
        inject.invoke(manager, new KeyEvent(downTime, SystemClock.uptimeMillis(), KeyEvent.ACTION_DOWN, code, 1, 0,
            KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_LONG_PRESS, InputDevice.SOURCE_KEYBOARD), INJECT_ASYNC);
    }

    private void touch(int action, float x, float y) throws Exception {
        long now = SystemClock.uptimeMillis();
        if (action == MotionEvent.ACTION_DOWN) touchTime = now;
        MotionEvent event = MotionEvent.obtain(touchTime, now, action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        inject.invoke(manager, event, INJECT_ASYNC);
        event.recycle();
    }

    /** A hidden call, and one that newer systems changed: whoever cannot use it takes screencap. */
    private static String shot() {
        try {
            Method screenshot = Class.forName("android.view.SurfaceControl")
                .getMethod("screenshot", Rect.class, int.class, int.class, int.class);
            Bitmap frame = (Bitmap) screenshot.invoke(null, new Rect(), SHOT_WIDTH, SHOT_HEIGHT, 0);
            if (frame == null) return "none";
            Bitmap copy = frame.copy(Bitmap.Config.ARGB_8888, false);
            ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
            copy.compress(Bitmap.CompressFormat.JPEG, SHOT_QUALITY, jpeg);
            // This process allocates so little that the GC would rarely come to free them.
            copy.recycle();
            frame.recycle();
            return Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return "none";
        }
    }

    private static int touchAction(String name) {
        if (name.equals("down")) return MotionEvent.ACTION_DOWN;
        return name.equals("up") ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
    }

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        KeyInput keys = new KeyInput();
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in));
        System.out.println("ready");
        for (String line; (line = input.readLine()) != null; ) {
            String[] parts = line.trim().split(" ");
            if (parts.length == 4 && parts[0].equals("touch")) {
                keys.touch(touchAction(parts[1]), Float.parseFloat(parts[2]), Float.parseFloat(parts[3]));
                System.out.println("ok");
                continue;
            }
            if (parts.length == 1 && parts[0].equals("shot")) {
                System.out.println(shot());
                continue;
            }
            if (parts.length != 2) continue;
            int code = KeyEvent.keyCodeFromString(parts[1]);
            if (parts[0].equals("press") || parts[0].equals("down")) keys.send(KeyEvent.ACTION_DOWN, code);
            if (parts[0].equals("long")) keys.held(code);
            if (parts[0].equals("press") || parts[0].equals("up")) keys.send(KeyEvent.ACTION_UP, code);
            System.out.println("ok");
        }
    }
}
