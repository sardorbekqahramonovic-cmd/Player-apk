// JNI ko'prigi: 16 kHz mono PCM fayldan whisper.cpp orqali subtitr segmentlarini oladi.
// Xotirani tejash uchun audio 10 daqiqalik bo'laklarda qayta ishlanadi.

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

static const int SAMPLE_RATE = 16000;
// Bo'lak uzunligi (soniya). Ilovada 10 daqiqa; sinovlarda qisqaroq berish mumkin.
#ifndef TIL_CHUNK_SECONDS
#define TIL_CHUNK_SECONDS 600
#endif
static const long CHUNK_SAMPLES = (long) TIL_CHUNK_SECONDS * SAMPLE_RATE;

struct ProgressCtx {
    JNIEnv * env;
    jobject obj;
    jmethodID mid;
    int chunk;
    int chunks;
    int last;
};

static void report(ProgressCtx * p, int chunkProgress) {
    int total = (p->chunk * 100 + chunkProgress) / p->chunks;
    if (total != p->last) {
        p->last = total;
        p->env->CallVoidMethod(p->obj, p->mid, (jint) total);
    }
}

static void on_progress(struct whisper_context *, struct whisper_state *, int progress, void * ud) {
    report((ProgressCtx *) ud, progress);
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

extern "C" JNIEXPORT void JNICALL
Java_uz_tilplayer_app_WhisperPlugin_nativeCancel(JNIEnv *, jclass) {
    g_abort = true;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_uz_tilplayer_app_WhisperPlugin_nativeTranscribe(
        JNIEnv * env, jobject thiz, jstring jmodel, jstring jpcm, jstring jlang, jint threads) {
    g_abort = false;

    const char * model = env->GetStringUTFChars(jmodel, nullptr);
    const char * pcm = env->GetStringUTFChars(jpcm, nullptr);
    const char * lang = env->GetStringUTFChars(jlang, nullptr);
    std::string language(lang);

    std::string out;
    FILE * f = fopen(pcm, "rb");
    whisper_context * ctx = nullptr;

    if (!f) {
        out = "{\"error\":\"pcm\"}";
    } else {
        fseek(f, 0, SEEK_END);
        long total_samples = ftell(f) / 2;
        fseek(f, 0, SEEK_SET);

        whisper_context_params cparams = whisper_context_default_params();
        cparams.use_gpu = false;
        ctx = whisper_init_from_file_with_params(model, cparams);

        if (!ctx) {
            out = "{\"error\":\"model\"}";
        } else {
            jclass cls = env->GetObjectClass(thiz);
            jmethodID mid = env->GetMethodID(cls, "onNativeProgress", "(I)V");
            int chunks = (int) ((total_samples + CHUNK_SAMPLES - 1) / CHUNK_SAMPLES);
            if (chunks < 1) chunks = 1;
            ProgressCtx pctx { env, thiz, mid, 0, chunks, -1 };

            std::vector<int16_t> raw(CHUNK_SAMPLES);
            std::vector<float> samples;
            samples.reserve(CHUNK_SAMPLES);

            out = "{\"segments\":[";
            bool first = true;
            bool aborted = false;
            bool failed = false;

            for (int c = 0; c < chunks && !aborted && !failed; ++c) {
                size_t n = fread(raw.data(), sizeof(int16_t), CHUNK_SAMPLES, f);
                if (n == 0) break;
                samples.resize(n);
                for (size_t i = 0; i < n; ++i) samples[i] = raw[i] / 32768.0f;

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
                pctx.chunk = c;
                wp.progress_callback = on_progress;
                wp.progress_callback_user_data = &pctx;
                wp.abort_callback = on_abort;
                wp.abort_callback_user_data = nullptr;

                int ret = whisper_full(ctx, wp, samples.data(), (int) samples.size());
                if (g_abort.load()) { aborted = true; break; }
                if (ret != 0) { failed = true; break; }

                const int64_t offset_ms = (int64_t) c * (CHUNK_SAMPLES / SAMPLE_RATE) * 1000;
                const int nseg = whisper_full_n_segments(ctx);
                for (int i = 0; i < nseg; ++i) {
                    const char * text = whisper_full_get_segment_text(ctx, i);
                    int64_t t0 = whisper_full_get_segment_t0(ctx, i) * 10 + offset_ms;
                    int64_t t1 = whisper_full_get_segment_t1(ctx, i) * 10 + offset_ms;
                    if (!first) out += ",";
                    first = false;
                    out += "{\"s\":" + std::to_string(t0) + ",\"e\":" + std::to_string(t1) + ",\"t\":\"";
                    json_escape(out, text ? text : "");
                    out += "\"}";
                }
                report(&pctx, 100);
            }
            out += "]";
            if (aborted) out += ",\"aborted\":true";
            if (failed) out += ",\"error\":\"whisper\"";
            out += "}";
            LOGI("tayyor: %d bo'lak, %ld namuna", chunks, total_samples);
        }
        fclose(f);
    }

    if (ctx) whisper_free(ctx);
    env->ReleaseStringUTFChars(jmodel, model);
    env->ReleaseStringUTFChars(jpcm, pcm);
    env->ReleaseStringUTFChars(jlang, lang);
    return to_bytes(env, out);
}
