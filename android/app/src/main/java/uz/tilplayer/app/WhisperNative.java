package uz.tilplayer.app;

/** whisper.cpp (libtilwhisper.so) uchun JNI chaqiruvlari. */
final class WhisperNative {

    static boolean loaded = false;
    static String loadError = null;

    static {
        try {
            System.loadLibrary("tilwhisper");
            loaded = true;
        } catch (Throwable t) {
            loadError = t.toString();
        }
    }

    /** Joriy bo'lakning foizi (0–100). */
    interface ProgressSink {
        void onProgress(int percent);
    }

    private WhisperNative() {}

    /** Modelni yuklaydi; xato bo'lsa 0 qaytaradi. */
    static native long init(String modelPath);

    static native void free(long ctx);

    /** Ishlayotgan run() ni to'xtatadi (boshqa oqimdan chaqirish mumkin). */
    static native void cancel();

    static native void resetCancel();

    /** PCM faylning [start, start+count) namunalarini taniydi; natija — JSON (UTF-8). */
    static native byte[] run(long ctx, String pcmPath, long start, long count, String language, int threads, ProgressSink sink);
}
