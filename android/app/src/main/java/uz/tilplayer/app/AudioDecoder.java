package uz.tilplayer.app;

import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.ShortBuffer;

/** Videodan ovozni ajratib, 16 kHz mono 16-bit PCM faylga yozadi. */
final class AudioDecoder {

    static final int TARGET_RATE = 16000;

    interface Progress {
        void onProgress(int percent);
    }

    interface CancelCheck {
        boolean isCancelled();
    }

    static class CancelledException extends Exception {}

    private AudioDecoder() {}

    static void decodeToPcm(File input, File output, Progress progress, CancelCheck cancel) throws Exception {
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
                if (cancel.isCancelled()) throw new CancelledException();
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
                                    progress.onProgress(percent);
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
                            FloatBuffer fb = ob.asFloatBuffer();
                            int frames = fb.remaining() / ch;
                            for (int i = 0; i < frames; i++) {
                                float sum = 0;
                                for (int c = 0; c < ch; c++) sum += fb.get();
                                resampler.push(sum / ch);
                            }
                        } else {
                            ShortBuffer sb = ob.asShortBuffer();
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
            progress.onProgress(100);
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
     * Oqimli qayta namunalash (resampling) 16 kHz ga: avval o'rtacha qiymat bilan
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
