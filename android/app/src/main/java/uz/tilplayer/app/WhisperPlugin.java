package uz.tilplayer.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Avtomatik subtitr uchun JS ko'prigi. Og'ir ish WhisperService (foreground service) ichida,
 * holat diskda (WhisperJob) — ilova yopilsa ham yo'qolmaydi.
 *
 * JS tomondan ish tartibi:
 *   beginUpload() -> appendChunk(base64)... -> start({ videoId, title, model, language })
 *   hodisalar: "progress" { stage, percent }, "done", "error" { message }, "paused", "cancelled"
 *   ilova qayta ochilganda: status() -> resume() yoki takeResult()
 */
@CapacitorPlugin(name = "Whisper")
public class WhisperPlugin extends Plugin {

    private final ExecutorService downloader = Executors.newSingleThreadExecutor();
    private volatile boolean downloading = false;
    private volatile boolean downloadCancelled = false;
    private OutputStream uploadOut = null;

    private File base() {
        return getContext().getFilesDir();
    }

    @Override
    public void load() {
        WhisperJob.listener = new WhisperJob.Listener() {
            @Override
            public void onProgress(String stage, int percent) {
                JSObject ev = new JSObject();
                ev.put("stage", stage);
                ev.put("percent", percent);
                notifyListeners("progress", ev);
            }

            @Override
            public void onDone() {
                notifyListeners("done", new JSObject());
            }

            @Override
            public void onError(String message) {
                JSObject ev = new JSObject();
                ev.put("message", message);
                notifyListeners("error", ev);
            }

            @Override
            public void onPaused() {
                notifyListeners("paused", new JSObject());
            }

            @Override
            public void onCancelled() {
                notifyListeners("cancelled", new JSObject());
            }
        };
    }

    @Override
    protected void handleOnDestroy() {
        WhisperJob.listener = null;
        super.handleOnDestroy();
    }

    // ---------- Holat ----------

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", WhisperNative.loaded);
        ret.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        if (WhisperNative.loadError != null) ret.put("error", WhisperNative.loadError);
        call.resolve(ret);
    }

    @PluginMethod
    public void modelInfo(PluginCall call) {
        File f = WhisperJob.modelFile(base(), call.getString("name", "base-q5_1"));
        JSObject ret = new JSObject();
        ret.put("downloaded", f.exists() && f.length() > 1_000_000);
        ret.put("size", f.exists() ? f.length() : 0);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        File f = WhisperJob.modelFile(base(), call.getString("name", ""));
        JSObject ret = new JSObject();
        ret.put("deleted", !f.exists() || f.delete());
        call.resolve(ret);
    }

    /** Joriy (yoki tugallanmagan) ish haqida ma'lumot. */
    @PluginMethod
    public void status(PluginCall call) {
        JSONObject st = WhisperJob.readState(base());
        JSObject ret = new JSObject();
        if (st == null) {
            ret.put("job", JSONObject.NULL);
        } else {
            JSObject job = new JSObject();
            job.put("videoId", st.optString("videoId"));
            job.put("title", st.optString("title"));
            job.put("model", st.optString("model"));
            job.put("language", st.optString("language"));
            job.put("stage", st.optString("stage"));
            job.put("percent", st.optInt("percent", 0));
            job.put("error", st.optString("error", ""));
            job.put("running", WhisperJob.running);
            job.put("canResume", !WhisperJob.running && WhisperJob.canResume(base(), st));
            ret.put("job", job);
        }
        call.resolve(ret);
    }

    // ---------- Modelni yuklab olish ----------

    @PluginMethod
    public void downloadModel(PluginCall call) {
        String name = call.getString("name");
        String url = call.getString("url");
        if (name == null || url == null) {
            call.reject("name va url kerak");
            return;
        }
        if (downloading) {
            call.reject("Model allaqachon yuklanmoqda");
            return;
        }
        downloading = true;
        downloadCancelled = false;
        downloader.execute(() -> {
            File target = WhisperJob.modelFile(base(), name);
            File part = new File(target.getPath() + ".part");
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                int code = conn.getResponseCode();
                if (code != 200) throw new IOException("HTTP " + code);
                long total = conn.getContentLengthLong();
                long received = 0;
                int lastPercent = -1;
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (downloadCancelled) throw new IOException("cancelled");
                        out.write(buf, 0, n);
                        received += n;
                        int percent = total > 0 ? (int) (received * 100 / total) : -1;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject ev = new JSObject();
                            ev.put("percent", percent);
                            notifyListeners("download", ev);
                        }
                    }
                }
                if (total > 0 && received != total) throw new IOException("Yuklash to'liq tugamadi");
                if (target.exists()) target.delete();
                if (!part.renameTo(target)) throw new IOException("Faylni saqlab bo'lmadi");
                JSObject ret = new JSObject();
                ret.put("size", target.length());
                call.resolve(ret);
            } catch (Exception e) {
                part.delete();
                if (downloadCancelled) call.reject("cancelled", "CANCELLED");
                else call.reject("Modelni yuklab bo'lmadi: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                downloading = false;
            }
        });
    }

    // ---------- Videoni JS'dan qabul qilish (bo'laklarda) ----------

    @PluginMethod
    public void beginUpload(PluginCall call) {
        if (WhisperJob.running) {
            call.reject("Boshqa video uchun subtitr yaratilmoqda");
            return;
        }
        try {
            closeUpload();
            WhisperJob.clear(base());
            uploadOut = new BufferedOutputStream(new FileOutputStream(WhisperJob.inputFile(base())), 1 << 20);
            call.resolve();
        } catch (IOException e) {
            call.reject("Vaqtinchalik faylni ochib bo'lmadi: " + e.getMessage());
        }
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String data = call.getString("data");
        if (uploadOut == null || data == null) {
            call.reject("beginUpload chaqirilmagan");
            return;
        }
        try {
            uploadOut.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Yozib bo'lmadi (xotira to'lgan bo'lishi mumkin): " + e.getMessage());
        }
    }

    private void closeUpload() {
        if (uploadOut != null) {
            try {
                uploadOut.close();
            } catch (IOException ignored) {}
            uploadOut = null;
        }
    }

    // ---------- Ishni boshlash / davom ettirish ----------

    @PluginMethod
    public void start(PluginCall call) {
        if (!WhisperNative.loaded) {
            call.reject("Bu qurilmada avtomatik subtitr ishlamaydi (" + WhisperNative.loadError + ")");
            return;
        }
        if (WhisperJob.running) {
            call.reject("Boshqa video uchun subtitr yaratilmoqda");
            return;
        }
        String model = call.getString("model", "base-q5_1");
        if (!WhisperJob.modelFile(base(), model).exists()) {
            call.reject("Model yuklab olinmagan");
            return;
        }
        closeUpload();
        if (!WhisperJob.inputFile(base()).exists()) {
            call.reject("Video uzatilmagan");
            return;
        }
        try {
            WhisperJob.create(base(), call.getString("videoId", ""), call.getString("title", ""), model, call.getString("language", "en"));
        } catch (Exception e) {
            call.reject("Ishni saqlab bo'lmadi: " + e.getMessage());
            return;
        }
        askNotificationPermission();
        WhisperService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        JSObject ret = new JSObject();
        JSONObject st = WhisperJob.readState(base());
        if (!WhisperJob.running && WhisperJob.canResume(base(), st)) {
            WhisperService.start(getContext());
            ret.put("resumed", true);
        } else {
            ret.put("resumed", false);
        }
        call.resolve(ret);
    }

    /** Tugagan ish natijasini beradi va ish papkasini tozalaydi. */
    @PluginMethod
    public void takeResult(PluginCall call) {
        JSONObject st = WhisperJob.readState(base());
        JSObject ret = new JSObject();
        if (st == null || !"done".equals(st.optString("stage"))) {
            call.resolve(ret);
            return;
        }
        try {
            ret.put("videoId", st.optString("videoId"));
            ret.put("title", st.optString("title"));
            ret.put("language", st.optString("language"));
            ret.put("segments", WhisperJob.collectSegments(base()));
            WhisperJob.clear(base());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Natijani o'qib bo'lmadi: " + e.getMessage());
        }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        downloadCancelled = true;
        closeUpload();
        if (WhisperJob.running) WhisperJob.requestCancel();
        else WhisperJob.clear(base());
        call.resolve();
    }

    /** Xato bilan tugagan ishni o'chirish. */
    @PluginMethod
    public void discard(PluginCall call) {
        if (!WhisperJob.running) WhisperJob.clear(base());
        call.resolve();
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && getActivity() != null
            && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7301);
        }
    }
}
