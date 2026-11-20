#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "lc3.h"

enum { FRAME_US = 10000, SAMPLE_RATE = 16000, FRAME_SAMPLES = 160, FRAME_BYTES = 40 };

JNIEXPORT jlong JNICALL
Java_com_s23u_atomicclient_GlassesAudio_00024Lc3_create(JNIEnv *env, jclass type) {
    void *memory = malloc(lc3_decoder_size(FRAME_US, SAMPLE_RATE));
    if (!memory) return 0;
    lc3_decoder_t decoder = lc3_setup_decoder(FRAME_US, SAMPLE_RATE, 0, memory);
    if (!decoder) {
        free(memory);
        return 0;
    }
    return (jlong)(intptr_t)decoder;
}

JNIEXPORT jboolean JNICALL
Java_com_s23u_atomicclient_GlassesAudio_00024Lc3_decode(
        JNIEnv *env, jclass type, jlong handle, jbyteArray packet, jint frames,
        jint concealed_frames, jshortArray output) {
    lc3_decoder_t decoder = (lc3_decoder_t)(intptr_t)handle;
    if (!decoder || frames < 1 || frames > 6 || concealed_frames < 0 || concealed_frames > 96
            || (*env)->GetArrayLength(env, packet) != 2 + frames * FRAME_BYTES
            || (*env)->GetArrayLength(env, output) != (frames + concealed_frames) * FRAME_SAMPLES) {
        return JNI_FALSE;
    }

    jbyte payload[6 * FRAME_BYTES];
    (*env)->GetByteArrayRegion(env, packet, 2, frames * FRAME_BYTES, payload);
    if ((*env)->ExceptionCheck(env)) return JNI_FALSE;
    jshort *pcm = (*env)->GetShortArrayElements(env, output, NULL);
    if (!pcm) return JNI_FALSE;

    int ok = 1;
    for (int i = 0; i < concealed_frames + frames; ++i) {
        const void *frame = i < concealed_frames ? NULL
                : payload + (i - concealed_frames) * FRAME_BYTES;
        if (lc3_decode(decoder, frame, frame ? FRAME_BYTES : 0,
                LC3_PCM_FORMAT_S16, pcm + i * FRAME_SAMPLES, 1) < 0) {
            ok = 0;
            break;
        }
    }
    (*env)->ReleaseShortArrayElements(env, output, pcm, ok ? 0 : JNI_ABORT);
    return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_s23u_atomicclient_GlassesAudio_00024Lc3_destroy(JNIEnv *env, jclass type, jlong handle) {
    free((void *)(intptr_t)handle);
}
