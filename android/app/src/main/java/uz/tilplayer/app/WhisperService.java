package uz.tilplayer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import org.json.JSONObject;

/**
 * Avtomatik subtitrni oldingi planda (foreground service) bajaradi: foydalanuvchi boshqa
 * ilovaga o'tsa yoki ekran o'chsa ham ish davom etadi, jarayon bildirishnomada ko'rinadi.
 * Tizim baribir to'xtatsa, holat diskda saqlangan — ilova qayta ochilganda davom etadi.
 */
public class WhisperService extends Service {

    static final String ACTION_START = "uz.tilplayer.app.WHISPER_START";
    static final String ACTION_CANCEL = "uz.tilplayer.app.WHISPER_CANCEL";

    private static final String CHANNEL_PROGRESS = "whisper_progress";
    private static final String CHANNEL_RESULT = "whisper_result";
    private static final int NOTIF_PROGRESS = 4201;
    private static final int NOTIF_RESULT = 4202;

    private Thread worker = null;
    private PowerManager.WakeLock wakeLock = null;
    private long lastNotify = 0;
    private int lastPercent = -1;
    private String lastStage = "";

    static void start(Context ctx) {
        Intent i = new Intent(ctx, WhisperService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_CANCEL.equals(action)) {
            if (WhisperJob.running) WhisperJob.requestCancel();
            else {
                WhisperJob.clear(getFilesDir());
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        // START yoki tizim tomonidan qayta ishga tushirish (intent == null)
        JSONObject st = WhisperJob.readState(getFilesDir());
        if (!WhisperJob.canResume(getFilesDir(), st)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!goForeground(st.optString("title"))) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            acquireWakeLock();
            worker = new Thread(this::work, "whisper-job");
            worker.start();
        }
        // Tizim xotira yetishmay to'xtatsa — o'zi qayta ishga tushirsin (ish diskdan davom etadi)
        return START_STICKY;
    }

    private void work() {
        int cores = Runtime.getRuntime().availableProcessors();
        int threads = Math.max(1, Math.min(4, cores));
        final String title = titleOf();
        WhisperJob.run(getFilesDir(), threads, new WhisperJob.Listener() {
            @Override
            public void onProgress(String stage, int percent) {
                updateProgress(title, stage, percent);
            }

            @Override
            public void onDone() {
                notifyResult("Subtitr tayyor", title + " — ilovani ochib koʻring");
            }

            @Override
            public void onError(String message) {
                notifyResult("Subtitr yaratib boʻlmadi", message);
            }

            @Override
            public void onPaused() {}

            @Override
            public void onCancelled() {}
        });
        releaseWakeLock();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private String titleOf() {
        JSONObject st = WhisperJob.readState(getFilesDir());
        return st != null ? st.optString("title", "") : "";
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15+: oldingi plan vaqti tugadi — to'xtatib turamiz, keyin ilovadan davom etadi
        WhisperJob.requestPause();
    }

    @Override
    public void onDestroy() {
        if (WhisperJob.running) WhisperJob.requestPause();
        releaseWakeLock();
        super.onDestroy();
    }

    // ---------- Bildirishnomalar ----------

    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_PROGRESS) == null) {
            NotificationChannel c = new NotificationChannel(CHANNEL_PROGRESS, "Avtomatik subtitr jarayoni", NotificationManager.IMPORTANCE_LOW);
            c.setShowBadge(false);
            nm.createNotificationChannel(c);
        }
        if (nm.getNotificationChannel(CHANNEL_RESULT) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_RESULT, "Avtomatik subtitr natijasi", NotificationManager.IMPORTANCE_DEFAULT));
        }
    }

    private PendingIntent openAppIntent() {
        Intent i = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification buildProgress(String title, String text, int percent) {
        Intent cancel = new Intent(this, WhisperService.class).setAction(ACTION_CANCEL);
        PendingIntent cancelPi = PendingIntent.getService(this, 1, cancel, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_launcher_tp)
            .setContentTitle("Subtitr yaratilmoqda" + (title.isEmpty() ? "" : " — " + title))
            .setContentText(text)
            .setProgress(100, Math.max(0, percent), percent < 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openAppIntent())
            .addAction(0, "Bekor qilish", cancelPi)
            .build();
    }

    private boolean goForeground(String title) {
        ensureChannels();
        Notification n = buildProgress(title, "Tayyorlanmoqda…", -1);
        try {
            if (Build.VERSION.SDK_INT >= 35) {
                startForeground(NOTIF_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_PROGRESS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_PROGRESS, n);
            }
            return true;
        } catch (Exception e) {
            // Masalan, tizim fonda qayta ishga tushirganda ruxsat bermasa — ilova ochilganda davom etadi
            return false;
        }
    }

    private void updateProgress(String title, String stage, int percent) {
        long now = System.currentTimeMillis();
        if (stage.equals(lastStage) && percent == lastPercent) return;
        if (stage.equals(lastStage) && now - lastNotify < 1000 && percent < 100) return;
        lastNotify = now;
        lastPercent = percent;
        lastStage = stage;
        String text = ("audio".equals(stage) ? "Ovoz ajratilmoqda" : "Nutq tanilmoqda") + " · " + percent + "%";
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NOTIF_PROGRESS, buildProgress(title, text, percent));
    }

    private void notifyResult(String title, String text) {
        ensureChannels();
        Notification n = new NotificationCompat.Builder(this, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_launcher_tp)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openAppIntent())
            .build();
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        try {
            nm.notify(NOTIF_RESULT, n);
        } catch (SecurityException ignored) {
            // bildirishnomaga ruxsat berilmagan
        }
    }

    // ---------- Ekran o'chsa ham protsessor ishlashi uchun ----------

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "TilPlayer:whisper");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(6 * 60 * 60 * 1000L); // eng ko'pi 6 soat
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
}
