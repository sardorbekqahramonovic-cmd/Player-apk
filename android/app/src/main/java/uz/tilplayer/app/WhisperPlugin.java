package uz.tilplayer.app;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.os.Build;
import android.util.Base64;
import android.view.WindowManager;
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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;

/**
 * Avtomatik subtitr: videodan ovozni ajratib, whisper.cpp yordamida telefonning o'zida
 * (internetsiz) matnga aylantiradi. Internet faqat modelni bir marta yuklab olishga kerak.
 *
 * Ish tartibi (JS tomondan):
 *   beginUpload() -> appendChunk(base64)... -> transcribe({ model, language })
 * Jarayon haqida "progress" hodisalari yuboriladi: { stage: "audio" | "asr", percent }.
 */
@CapacitorPlugin(name = "Whisper")
public class WhisperPlugin extends Plugin {

    private static final int TARGET_RATE = 16000;

    private static boolean libLoaded = false;
    private static String libError = null;

    static {
        try {
            System.loadLibrary("tilwhisper");
            libLoaded = true;
        } catch (Throwable t) {
            libError = t.toString();
        }
    }

    private native byte[] nativeTranscribe(String modelPath, String pcmPath, String language, int threads);

    private static native void nativeCancel();

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile boolean cancelled = false;
    private volatile boolean busy = false;
    private OutputStream uploadOut = null;

    private File modelsDir() {
        File dir = new File(getContext().getFilesDir(), "whisper-models");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private File modelFile(String name) {
        return new File(modelsDir(), "ggml-" + name.replaceAll("[^A-Za-z0-9._-]", "") + ".bin");
    }

    private File uploadFile() {
        return new File(getContext().getCacheDir(), "whisper-input.bin");
    }

    private File pcmFile() {
        return new File(getContext().getCacheDir(), "whisper-audio.pcm");
    }

    // ---------- Holat ----------

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", libLoaded);
        ret.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        ret.put("busy", busy);
        if (libError != null) ret.put("error", libError);
        call.resolve(ret);
    }

    @PluginMethod
    public void modelInfo(PluginCall call) {
        File f = modelFile(call.getString("name", "base-q5_1"));
        JSObject ret = new JSObject();
        ret.put("downloaded", f.exists() && f.length() > 1_000_000);
        ret.put("size", f.exists() ? f.length() : 0);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        File f = modelFile(call.getString("name", ""));
        boolean ok = !f.exists() || f.delete();
        JSObject ret = new JSObject();
        ret.put("deleted", ok);
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
        if (busy) {
            call.reject("Boshqa jarayon ketmoqda");
            return;
        }
        busy = true;
        cancelled = false;
        worker.execute(() -> {
            File target = modelFile(name);
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
                        if (cancelled) throw new IOException("cancelled");
                        out.write(buf, 0, n);
                        received += n;
                        int percent = total > 0 ? (int) (received * 100 / total) : -1;
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject ev = new JSObject();
                            ev.put("percent", percent);
                            ev.put("received", received);
                            ev.put("total", total);
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
                if (cancelled) call.reject("cancelled", "CANCELLED");
                else call.reject("Modelni yuklab bo'lmadi: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                busy = false;
            }
        });
    }

    // ---------- Videoni JS'dan qabul qilish (bo'laklarda) ----------

    @PluginMethod
    public void beginUpload(PluginCall call) {
        try {
            closeUpload();
            uploadOut = new BufferedOutputStream(new FileOutputStream(uploadFile()), 1 << 20);
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

    // ---------- Nutqni tanish ----------

    @PluginMethod
    public void transcribe(PluginCall call) {
        if (!libLoaded) {
            call.reject("Bu qurilmada avtomatik subtitr ishlamaydi (" + libError + ")");
            return;
        }
        if (busy) {
            call.reject("Boshqa jarayon ketmoqda");
            return;
        }
        String name = call.getString("model", "base-q5_1");
        String language = call.getString("language", "en");
        File model = modelFile(name);
        if (!model.exists()) {
            call.reject("Model yuklab olinmagan");
            return;
        }
        closeUpload();
        busy = true;
        cancelled = false;
        setKeepScreenOn(true);
        worker.execute(() -> {
            File input = uploadFile();
            File pcm = pcmFile();
            try {
                decodeToPcm(input, pcm);
                input.delete();
                if (cancelled) throw new InterruptedException();

                progress("asr", 0);
                int cores = Runtime.getRuntime().availableProcessors();
                int threads = Math.max(1, Math.min(4, cores));
                byte[] json = nativeTranscribe(model.getAbsolutePath(), pcm.getAbsolutePath(), language, threads);
                JSObject ret = new JSObject(new String(json, StandardCharsets.UTF_8));
                if (ret.has("aborted") || cancelled) throw new InterruptedException();
                if (ret.has("error")) throw new IOException("whisper: " + ret.getString("error"));
                call.resolve(ret);
            } catch (InterruptedException e) {
                call.reject("cancelled", "CANCELLED");
            } catch (JSONException e) {
                call.reject("Natijani o'qib bo'lmadi: " + e.getMessage());
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : e.toString());
            } finally {
                input.delete();
                pcm.delete();
                busy = false;
                setKeepScreenOn(false);
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        cancelled = true;
        if (libLoaded) nativeCancel();
        call.resolve();
    }

    /** C++ tomondan chaqiriladi (whisper jarayoni foizi). */
    @SuppressWarnings("unused")
    public void onNativeProgress(int percent) {
        progress("asr", percent);
    }

    private void progress(String stage, int percent) {
        JSObject ev = new JSObject();
        ev.put("stage", stage);
        ev.put("percent", percent);
        notifyListeners("progress", ev);
    }

    private void setKeepScreenOn(boolean on) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    // ---------- Videodan ovozni ajratish: 16 kHz, mono, 16-bit PCM ----------

    private void decodeToPcm(File input, File output) throws Exception {
        MediaExtractor extractor = new MediaExtractor();
        MediaCodec codec = null;
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(output), 1 << 20)) {
            extractor.setDataSource(input.getAbsolutePath());
            int track = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    format = f;
                    break;
                }
            }
            if (track < 0) throw new IOException("Videoda ovoz yo'lagi topilmadi");
            extractor.selectTrack(track);
            String mime = format.getString(MediaFormat.KEY_MIME);
            long durationUs = format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) : 0;

            try {
                codec = MediaCodec.createDecoderByType(mime);
                codec.configure(format, null, null, 0);
            } catch (Exception e) {
                throw new IOException("Qurilma bu ovoz formatini o'qiy olmaydi (" + mime + ")");
            }
            codec.start();

            int sampleRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            Resampler resampler = new Resampler(sampleRate, out);

            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean outputDone = false;
            int lastPercent = -1;

            while (!outputDone) {
                if (cancelled) throw new InterruptedException();
                if (!inputDone) {
                    int inIndex = codec.dequeueInputBuffer(10000);
                    if (inIndex >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(inIndex);
                        int size = buf == null ? -1 : extractor.readSampleData(buf, 0);
                        if (size < 0) {
                            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            long t = extractor.getSampleTime();
                            codec.queueInputBuffer(inIndex, 0, size, t, 0);
                            extractor.advance();
                            if (durationUs > 0) {
                                int percent = (int) Math.min(100, t * 100 / durationUs);
                                if (percent != lastPercent) {
                                    lastPercent = percent;
                                    progress("audio", percent);
                                }
                            }
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, 10000);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    if (of.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
                        sampleRate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                        resampler.setInputRate(sampleRate);
                    }
                    if (of.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    if (of.containsKey(MediaFormat.KEY_PCM_ENCODING)) encoding = of.getInteger(MediaFormat.KEY_PCM_ENCODING);
                } else if (outIndex >= 0) {
                    ByteBuffer ob = codec.getOutputBuffer(outIndex);
                    if (ob != null && info.size > 0) {
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        ob.order(ByteOrder.nativeOrder());
                        int ch = Math.max(1, channels);
                        if (encoding == AudioFormat.ENCODING_PCM_FLOAT) {
                            java.nio.FloatBuffer fb = ob.asFloatBuffer();
                            int frames = fb.remaining() / ch;
                            for (int i = 0; i < frames; i++) {
                                float sum = 0;
                                for (int c = 0; c < ch; c++) sum += fb.get();
                                resampler.push(sum / ch);
                            }
                        } else {
                            java.nio.ShortBuffer sb = ob.asShortBuffer();
                            int frames = sb.remaining() / ch;
                            for (int i = 0; i < frames; i++) {
                                float sum = 0;
                                for (int c = 0; c < ch; c++) sum += sb.get() / 32768f;
                                resampler.push(sum / ch);
                            }
                        }
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) outputDone = true;
                }
            }
            resampler.flush();
            progress("audio", 100);
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (Exception ignored) {}
                codec.release();
            }
            extractor.release();
        }
    }

    /**
     * Oddiy oqimli qayta namunalash (resampling) 16 kHz ga: avval o'rtacha qiymat bilan
     * past chastota filtri (aliasingni kamaytirish uchun), keyin chiziqli interpolyatsiya.
     */
    private static class Resampler {
        private final OutputStream out;
        private final byte[] buf = new byte[1 << 15];
        private int bufPos = 0;
        private double ratio;
        private int window;
        private float[] ring;
        private int ringPos = 0;
        private float ringSum = 0;
        private long n = 0;
        private double nextOut = 0;
        private float prev = 0;

        Resampler(int inputRate, OutputStream out) {
            this.out = out;
            setInputRate(inputRate);
        }

        void setInputRate(int inputRate) {
            ratio = inputRate / (double) TARGET_RATE;
            window = Math.max(1, (int) Math.round(ratio));
            ring = new float[window];
            ringPos = 0;
            ringSum = 0;
        }

        void push(float x) throws IOException {
            ringSum += x - ring[ringPos];
            ring[ringPos] = x;
            ringPos = (ringPos + 1) % window;
            float cur = ringSum / window;
            while (nextOut <= n) {
                double frac = nextOut - (n - 1);
                write((float) (prev + (cur - prev) * frac));
                nextOut += ratio;
            }
            prev = cur;
            n++;
        }

        private void write(float v) throws IOException {
            int s = (int) Math.max(-32768, Math.min(32767, Math.round(v * 32767f)));
            buf[bufPos++] = (byte) (s & 0xff);
            buf[bufPos++] = (byte) ((s >> 8) & 0xff);
            if (bufPos >= buf.length) {
                out.write(buf, 0, bufPos);
                bufPos = 0;
            }
        }

        void flush() throws IOException {
            if (bufPos > 0) out.write(buf, 0, bufPos);
            bufPos = 0;
            out.flush();
        }
    }
}
