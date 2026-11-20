package com.s23u.atomicclient;

interface PcmInput {
    boolean isConnected();
    void clearBuffer();
    int bufferedSamples();

    // Positive: samples copied. Zero: timed out. Negative: the source disconnected.
    int read(short[] destination, int maxSamples, int timeoutMs);
}
