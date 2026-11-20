#include <android/log.h>
#include <dlfcn.h>
#include <jni.h>
#include <stdlib.h>
#include <string.h>

typedef int (*node_start)(int, char **);

JNIEXPORT jint JNICALL
Java_com_s23u_atomicclient_MootingAgentActivity_runNode(
        JNIEnv *env, jclass activity, jobjectArray arguments) {
    (void) activity;
    void *node = dlopen("libnode.so", RTLD_NOW | RTLD_LOCAL);
    if (!node) {
        __android_log_print(ANDROID_LOG_ERROR, "MootingAgent", "%s", dlerror());
        return -1;
    }
    node_start start = (node_start) dlsym(node, "_ZN4node5StartEiPPc");
    if (!start) {
        __android_log_print(ANDROID_LOG_ERROR, "MootingAgent", "%s", dlerror());
        dlclose(node);
        return -2;
    }
    jsize count = (*env)->GetArrayLength(env, arguments);
    char **argv = calloc((size_t) count + 1, sizeof(*argv));
    if (!argv) return -3;
    int result = -3;
    for (jsize index = 0; index < count; index++) {
        jstring argument = (*env)->GetObjectArrayElement(env, arguments, index);
        const char *value = (*env)->GetStringUTFChars(env, argument, NULL);
        if (value) {
            argv[index] = strdup(value);
            (*env)->ReleaseStringUTFChars(env, argument, value);
        }
        (*env)->DeleteLocalRef(env, argument);
        if (!argv[index]) goto cleanup;
    }
    result = start(count, argv);

cleanup:
    for (jsize index = 0; index < count; index++) free(argv[index]);
    free(argv);
    return result;
}
