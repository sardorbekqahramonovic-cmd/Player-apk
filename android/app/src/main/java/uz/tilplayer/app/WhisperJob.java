package uz.tilplayer.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Avtomatik subtitr ishi — diskda saqlanadigan holat bilan.
 *
 * Papka (whisper-job/):
 *   job.json        — holat: videoId, title, model, language, stage, nextStart, totalSamples, percent
 *   input.bin       — JS'dan kelgan video (ovoz ajratilgach o'chiriladi)
 *   audio.pcm       — 16 kHz mono 16-bit ovoz
 *   segments.jsonl  — har bir tugagan bo'lak natijasi: {"start":..,"segments":[..]}
 *
 * Ovoz ~3 daqiqalik bo'laklarda (jim joyda kesilib) tanib olinadi va har bir bo'lakdan keyin
 * natija diskka yoziladi. Ilova yoki telefon jarayonni to'xtatsa, ish oxirgi tugagan bo'lakdan
 * davom etadi — boshidan emas.
 *
 * stage: "decode" -> "asr" -> "done" | "error"
 */
final class WhisperJob {

    static final int RATE = 16000;
    static final long CHUNK_SAMPLES = 180L * RATE; // 3 daqiqa
    static final long QUIET_SEARCH = 3L * RATE; // kesish joyi bo'lak oxirining 3 soniyasi ichidan izlanadi

    interface Listener {
        void onProgress(String stage, int percent);

        void onDone();

        void onError(String message);

        void onPaused();

        void onCancelled();
    }

    static volatile Listener listener = null;
    static volatile boolean running = false;
    private static volatile boolean cancelRequested = false;
    private static volatile boolean pauseRequested = false;

    private static class StopException extends Exception {}

    private WhisperJob() {}

    // ---------- Fayllar ----------

    static File dir(File base) {
        File d = new File(base, "whisper-job");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File stateFile(File base) {
        return new File(dir(base), "job.json");
    }

    static File inputFile(File base) {
        return new File(dir(base), "input.bin");
    }

    static File pcmFile(File base) {
        return new File(dir(base), "audio.pcm");
    }

    static File segmentsFile(File base) {
        return new File(dir(base), "segments.jsonl");
    }

    static File modelFile(File base, String name) {
        File d = new File(base, "whisper-models");
        if (!d.exists()) d.mkdirs();
        return new File(d, "ggml-" + name.replaceAll("[^A-Za-z0-9._-]", "") + ".bin");
    }

    static synchronized JSONObject readState(File base) {
        File f = stateFile(base);
        if (!f.exists()) return null;
        try {
            return new JSONObject(readUtf8(f));
        } catch (Exception e) {
            return null;
        }
    }

    static synchronized void writeState(File base, JSONObject st) throws IOException {
        File f = stateFile(base);
        File tmp = new File(f.getPath() + ".tmp");
        try {
            st.put("updatedAt", System.currentTimeMillis());
        } catch (JSONException ignored) {}
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(st.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(f)) throw new IOException("Holatni saqlab bo'lmadi");
    }

    static synchronized void clear(File base) {
        File[] files = dir(base).listFiles();
        if (files != null) for (File f : files) f.delete();
    }

    /** Yangi ish: video input.bin ga yozib bo'lingan bo'lishi kerak. */
    static void create(File base, String videoId, String title, String model, String language) throws Exception {
        JSONObject st = new JSONObject();
        st.put("videoId", videoId);
        st.put("title", title);
        st.put("model", model);
        st.put("language", language);
        st.put("stage", "decode");
        st.put("percent", 0);
        st.put("createdAt", System.currentTimeMillis());
        segmentsFile(base).delete();
        pcmFile(base).delete();
        writeState(base, st);
    }

    /** Ishni davom ettirish mumkinmi (jarayon to'xtatilgan, lekin fayllar joyida). */
    static boolean canResume(File base, JSONObject st) {
        if (st == null) return false;
        String stage = st.optString("stage");
        if ("decode".equals(stage)) return inputFile(base).exists();
        if ("asr".equals(stage)) return pcmFile(base).exists();
        return false;
    }

    // ---------- Boshqaruv ----------

    static void requestCancel() {
        cancelRequested = true;
        if (WhisperNative.loaded) WhisperNative.cancel();
    }

    /** Ishni to'xtatib turish (holat saqlanadi, keyin davom ettiriladi). */
    static void requestPause() {
        pauseRequested = true;
        if (WhisperNative.loaded) WhisperNative.cancel();
    }

    private static void checkStop() throws StopException {
        if (cancelRequested || pauseRequested) throw new StopException();
    }

    private static void emit(String stage, int percent) {
        Listener l = listener;
        if (l != null) l.onProgress(stage, percent);
    }

    // ---------- Asosiy ish ----------

    /**
     * Ishni oxirigacha (yoki to'xtatilguncha) bajaradi. Joriy oqimni band qiladi.
     * progress — qo'shimcha kuzatuvchi (masalan, bildirishnoma).
     */
    static void run(File base, int threads, Listener progress) {
        synchronized (WhisperJob.class) {
            if (running) return;
            running = true;
        }
        cancelRequested = false;
        pauseRequested = false;
        if (WhisperNative.loaded) WhisperNative.resetCancel();
        JSONObject st = readState(base);
        try {
            if (st == null) return;
            String stage = st.optString("stage");

            if ("decode".equals(stage)) {
                File input = inputFile(base);
                if (!input.exists()) throw new IOException("Video fayli topilmadi — qaytadan boshlang");
                both(progress, "audio", 0);
                AudioDecoder.decodeToPcm(input, pcmFile(base),
                    p -> both(progress, "audio", p),
                    () -> cancelRequested || pauseRequested);
                checkStop();
                input.delete();
                segmentsFile(base).delete();
                st.put("stage", "asr");
                st.put("nextStart", 0);
                st.put("totalSamples", pcmFile(base).length() / 2);
                st.put("percent", 0);
                writeState(base, st);
                stage = "asr";
            }

            if ("asr".equals(stage)) {
                transcribe(base, st, threads, progress);
                st.put("stage", "done");
                st.put("percent", 100);
                writeState(base, st);
                pcmFile(base).delete();
                Listener l = listener;
                if (l != null) l.onDone();
                if (progress != null) progress.onDone();
            }
        } catch (StopException | AudioDecoder.CancelledException e) {
            if (cancelRequested) {
                clear(base);
                Listener l = listener;
                if (l != null) l.onCancelled();
                if (progress != null) progress.onCancelled();
            } else {
                Listener l = listener;
                if (l != null) l.onPaused();
                if (progress != null) progress.onPaused();
            }
        } catch (Throwable e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.toString();
            try {
                if (st != null) {
                    st.put("stage", "error");
                    st.put("error", msg);
                    writeState(base, st);
                }
            } catch (Exception ignored) {}
            Listener l = listener;
            if (l != null) l.onError(msg);
            if (progress != null) progress.onError(msg);
        } finally {
            running = false;
        }
    }

    private static void both(Listener extra, String stage, int percent) {
        emit(stage, percent);
        if (extra != null) extra.onProgress(stage, percent);
    }

    private static void transcribe(File base, JSONObject st, int threads, Listener progress) throws Exception {
        File model = modelFile(base, st.getString("model"));
        if (!model.exists()) throw new IOException("Model topilmadi — qaytadan yuklab oling");
        File pcm = pcmFile(base);
        long total = st.optLong("totalSamples", pcm.length() / 2);
        long next = st.optLong("nextStart", 0);
        String language = st.optString("language", "en");

        // whisper o'z foizini 100 dan oshirib yuborishi mumkin (oxirgi 30 s oyna) — cheklaymiz va
        // foiz hech qachon orqaga ketmasligini ta'minlaymiz
        final int[] shown = { total > 0 ? (int) (next * 100 / total) : 0 };
        both(progress, "asr", shown[0]);
        long ctx = WhisperNative.init(model.getAbsolutePath());
        if (ctx == 0) throw new IOException("Modelni ochib bo'lmadi (fayl buzilgan bo'lishi mumkin) — uni sozlamalardan o'chirib, qayta yuklang");
        try {
            while (next < total) {
                checkStop();
                final long s0 = next;
                final long end = chunkEnd(pcm, next, total);
                final long len = end - s0;
                final long tot = total;
                byte[] raw = WhisperNative.run(ctx, pcm.getAbsolutePath(), s0, len, language, threads,
                    new WhisperNative.ProgressSink() {
                        @Override
                        public void onProgress(int p) {
                            int pp = Math.max(0, Math.min(100, p));
                            int overall = Math.min(99, (int) ((s0 + len * pp / 100.0) * 100 / tot));
                            if (overall > shown[0]) {
                                shown[0] = overall;
                                both(progress, "asr", overall);
                            }
                        }
                    });
                JSONObject r = new JSONObject(new String(raw, StandardCharsets.UTF_8));
                checkStop();
                if (r.optBoolean("aborted")) throw new StopException();
                if (r.has("error")) throw new IOException("Nutqni tanishda xato (" + r.optString("error") + ")");

                JSONObject line = new JSONObject();
                line.put("start", s0);
                line.put("segments", r.optJSONArray("segments") != null ? r.getJSONArray("segments") : new JSONArray());
                try (FileOutputStream out = new FileOutputStream(segmentsFile(base), true)) {
                    out.write((line.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                next = end;
                st.put("nextStart", next);
                st.put("percent", (int) (next * 100 / total));
                writeState(base, st);
                int done = (int) (next * 100 / total);
                if (done > shown[0] || next >= total) {
                    shown[0] = done;
                    both(progress, "asr", done);
                }
            }
        } finally {
            WhisperNative.free(ctx);
        }
    }

    /**
     * Bo'lak oxiri: start + 3 daqiqa atrofidagi eng jim joy (so'z o'rtasidan kesmaslik uchun).
     * Natija deterministik — davom ettirilganda ham aynan shu chegaralar tanlanadi.
     */
    static long chunkEnd(File pcm, long start, long total) throws IOException {
        long target = start + CHUNK_SAMPLES;
        if (target >= total) return total;
        long from = Math.max(start + RATE, target - QUIET_SEARCH);
        int frame = RATE / 50; // 20 ms
        int n = (int) (target - from);
        byte[] buf = new byte[n * 2];
        try (RandomAccessFile raf = new RandomAccessFile(pcm, "r")) {
            raf.seek(from * 2);
            raf.readFully(buf);
        }
        long best = target;
        double bestEnergy = Double.MAX_VALUE;
        for (int off = 0; off + frame <= n; off += frame) {
            double e = 0;
            for (int i = off; i < off + frame; i++) {
                int s = (short) ((buf[2 * i] & 0xff) | (buf[2 * i + 1] << 8));
                e += (double) s * s;
            }
            if (e < bestEnergy) {
                bestEnergy = e;
                best = from + off + frame / 2;
            }
        }
        return best;
    }

    // java.nio.file Android 8 dan boshlab bor; ilova Android 7 ni ham qo'llaydi
    static String readUtf8(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /** Tugagan ish natijasi: barcha bo'laklar segmentlari (takroriy yozuvlar olib tashlanadi). */
    static JSONArray collectSegments(File base) throws Exception {
        File f = segmentsFile(base);
        Map<Long, JSONArray> byStart = new TreeMap<>();
        if (f.exists()) {
            for (String s : readUtf8(f).split("\n")) {
                if (s.trim().isEmpty()) continue;
                try {
                    JSONObject o = new JSONObject(s);
                    byStart.put(o.getLong("start"), o.getJSONArray("segments"));
                } catch (JSONException ignored) {
                    // oxirgi qator yarim yozilgan bo'lishi mumkin — e'tiborsiz
                }
            }
        }
        JSONArray all = new JSONArray();
        List<JSONArray> parts = new ArrayList<>(byStart.values());
        for (JSONArray part : parts) {
            for (int i = 0; i < part.length(); i++) all.put(part.get(i));
        }
        return all;
    }
}
