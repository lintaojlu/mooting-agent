package com.s23u.atomic.agent;

import com.s23u.atomic.agent.IAgentAtomicCallback;

interface IAgentAtomicService {
    String getCapabilities();
    void invoke(String requestId, String operation, String payloadJson, IAgentAtomicCallback callback);
    void cancel(String requestId);
}
