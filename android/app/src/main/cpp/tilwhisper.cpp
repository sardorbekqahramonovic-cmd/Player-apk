// JNI ko'prigi (uz.tilplayer.app.WhisperNative): whisper.cpp modelini yuklash va
// 16 kHz mono PCM faylning berilgan qismini matnga aylantirish.
// Bo'laklarga ajratish va natijalarni diskka saqlash Java tomonda (WhisperJob) —
// shunda ilova to'xtatilsa ham ish oxirgi tugagan bo'lakdan davom etadi.

#include <jni.h>
#include <android/log.h>

#include <atomic>
#include <cstdio>
#include <string>
#include <vector>

#include "whisper.h"

#define LOG_TAG "TilWhisper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

static std::atomic<bool> g_abort(false);

struct ProgressCtx {
    JNIEnv * env;
    jobject sink;
    jmethodID mid;
    int last;
};

static void on_progress(struct whisper_context *, struct whisper_state *, int progress, void * ud) {
    auto * p = (ProgressCtx *) ud;
    if (p->sink && p->mid && progress != p->last) {
        p->last = progress;
        p->env->CallVoidMethod(p->sink, p->mid, (jint) progress);
    }
}

static bool on_abort(void *) {
    return g_abort.load();
}

static void json_escape(std::string & out, const char * s) {
    for (; *s; ++s) {
        unsigned char c = (unsigned char) *s;
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': break;
            case '\t': out += ' '; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char) c;
                }
        }
    }
}

static jbyteArray to_bytes(JNIEnv * env, const std::string & s) {
    jbyteArray arr = env->NewByteArray((jsize) s.size());
    env->SetByteArrayRegion(arr, 0, (jsize) s.size(), (const jbyte *) s.data());
    return arr;
}

extern "C" JNIEXPORT jlong JNICALL
Java_uz_tilplayer_app_WhisperNative_init(JNIEnv * env, jclass, jstring jmodel) {
    const char * model = env->GetStringUTFChars(jmodel, nullptr);
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = false;
    whisper_context * ctx = whisper_init_from_file_with_params(model, cparams);
    env->ReleaseStringUTFChars(jmodel, model);
    return (jlong) ctx;
}

extern "C" JNIEXPORT void JNICALL
Java_uz_tilplayer_app_WhisperNative_free(JNIEnv *, jclass, jlong ptr) {
    if (ptr) whisper_free((whisper_context *) ptr);
}

extern "C" JNIEXPORT void JNICALL
Java_uz_tilplayer_app_WhisperNative_cancel(JNIEnv *, jclass) {
    g_abort = true;
}

extern "C" JNIEXPORT void JNICALL
Java_uz_tilplayer_app_WhisperNative_resetCancel(JNIEnv *, jclass) {
    g_abort = false;
}

// PCM faylning [start, start+count) namunalarini tanib, segmentlarni JSON sifatida qaytaradi:
// {"segments":[{"s":ms,"e":ms,"t":"..."}], "aborted":true?, "error":"..."?}
// Vaqtlar fayl boshidan hisoblanadi (millisekund).
extern "C" JNIEXPORT jbyteArray JNICALL
Java_uz_tilplayer_app_WhisperNative_run(
        JNIEnv * env, jclass, jlong ptr, jstring jpcm, jlong start, jlong count,
        jstring jlang, jint threads, jobject sink) {
    auto * ctx = (whisper_context *) ptr;
    if (!ctx) return to_bytes(env, "{\"error\":\"model\"}");

    const char * pcm = env->GetStringUTFChars(jpcm, nullptr);
    const char * lang = env->GetStringUTFChars(jlang, nullptr);
    std::string language(lang);
    std::string out;

    FILE * f = fopen(pcm, "rb");
    if (!f) {
        out = "{\"error\":\"pcm\"}";
    } else if (count <= 0 || fseek(f, (long) (start * 2), SEEK_SET) != 0) {
        out = "{\"segments\":[]}";
        fclose(f);
    } else {
        std::vector<int16_t> raw((size_t) count);
        size_t n = fread(raw.data(), sizeof(int16_t), (size_t) count, f);
        fclose(f);
        std::vector<float> samples(n);
        for (size_t i = 0; i < n; ++i) samples[i] = raw[i] / 32768.0f;
        raw.clear();
        raw.shrink_to_fit();

        ProgressCtx pctx { env, sink, nullptr, -1 };
        if (sink) {
            jclass cls = env->GetObjectClass(sink);
            pctx.mid = env->GetMethodID(cls, "onProgress", "(I)V");
        }

        whisper_full_params wp = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        wp.n_threads = threads;
        wp.language = language.c_str();
        wp.translate = false;
        wp.no_context = true;
        wp.print_progress = false;
        wp.print_realtime = false;
        wp.print_timestamps = false;
        wp.print_special = false;
        wp.suppress_blank = true;
        // Subtitr uchun qisqa qatorlar: so'z chegarasida, ~80 belgidan bo'lish
        wp.token_timestamps = true;
        wp.max_len = 80;
        wp.split_on_word = true;
        wp.progress_callback = on_progress;
        wp.progress_callback_user_data = &pctx;
        wp.abort_callback = on_abort;
        wp.abort_callback_user_data = nullptr;

        int ret = n > 0 ? whisper_full(ctx, wp, samples.data(), (int) samples.size()) : 0;

        if (g_abort.load()) {
            out = "{\"segments\":[],\"aborted\":true}";
        } else if (ret != 0) {
            out = "{\"segments\":[],\"error\":\"whisper\"}";
        } else {
            const int64_t offset_ms = (int64_t) start * 1000 / 16000;
            out = "{\"segments\":[";
            const int nseg = n > 0 ? whisper_full_n_segments(ctx) : 0;
            for (int i = 0; i < nseg; ++i) {
                const char * text = whisper_full_get_segment_text(ctx, i);
                int64_t t0 = whisper_full_get_segment_t0(ctx, i) * 10 + offset_ms;
                int64_t t1 = whisper_full_get_segment_t1(ctx, i) * 10 + offset_ms;
                if (i) out += ",";
                out += "{\"s\":" + std::to_string(t0) + ",\"e\":" + std::to_string(t1) + ",\"t\":\"";
                json_escape(out, text ? text : "");
                out += "\"}";
            }
            out += "]}";
            LOGI("bo'lak tayyor: %d segment, %zu namuna", nseg, n);
        }
    }

    env->ReleaseStringUTFChars(jpcm, pcm);
    env->ReleaseStringUTFChars(jlang, lang);
    return to_bytes(env, out);
}
