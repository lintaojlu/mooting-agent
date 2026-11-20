package com.s23u.atomic.agent;

oneway interface IAgentAtomicCallback {
    void onEvent(String requestId, String eventJson);
}
