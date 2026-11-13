# sound2text

Real Volcengine 2.0 streaming ASR adapter. It never substitutes simulated text when credentials, transport or recognition fail.

Protocol sources: [official WebSocket API](https://docs.volcengine.com/docs/doubao-voice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) and its [Python sample](https://portal.volccdn.com/obj/volcfe/cloud-universal-doc/upload_f9323339af7c7ce6d15678622eb77ccf.zip), specifically `protocol.py` (inspected, not executed). Client packets use a four-byte version/type/serialization/compression header, signed big-endian sequence, unsigned compressed-body length and gzip body. Terminal audio uses flags 3 and negative sequence. Initialization and audio serialization/compression bits follow the official sample.

## Cordis and transport

`plugin.mjs` exports the service mounted as `ctx.sound2text`. It exposes `ready`, `events`, `state()`, `start(owner?)`, `pushAudio(buffer)`, `pause(reason)`, `subscribe(listener)`, `armCapture(boundaryMs?)`, `finishCapture(reason?, endBoundaryMs?)`, `cancelCapture(reason?)`. `subscribe` listens to complete `change` states, including pause and failure transitions, and returns a disposer.

`mountSound2text(server, sound)` in `http-ws.mjs` attaches `/api/sound2text/audio` and returns an asynchronous disposer. Only an exact `http://127.0.0.1:<port>` Origin with matching Host is accepted; one connected browser owns audio transport. Incoming JSON commands are `{type:'start'}`, `{type:'pause'}`, and `{type:'cancel_capture'}`. The last command synchronously cancels an unfinished instruction before pause flushes tail audio; it cannot start or submit capture. Capture and Router interruption must use the application's coordinated HTTP interaction endpoint, not this audio socket. Binary messages are PCM signed little-endian 16-bit, mono, 16kHz; browser input is bounded to 64000 bytes/message. The service aggregates 6400-byte/200ms cloud packets. Browser WebAudio must actually resample rather than relying on a requested device sample rate.

Outgoing messages are `{type:'ready',state}`, `{type:'state',state}`, `{type:'ack',action:'pause',state}`, or `{type:'error',error}`. Ready follows the cloud initialization acknowledgement. Cloud terminal messages are awaited on pause, bounded by final-wait timeout; no unfinished instruction is committed on pause.

## Public state and events

State: `{configured,status,text,utterances,audioMs,capture,error?}`. Status is `stopped`, `connecting`, `running`, `stopping`, or `error`. Capture status is `idle`, `listening`, or `finishing`; while active it carries `id`, `boundaryMs`, voice and cutoff times. Public values do not contain credentials.

Events:

- `change`: complete public state.
- `text`: `{text,utterances,audioMs}`, separate from full-state subscription.
- `capture`: current capture state.
- `instruction`: `{text,id,reason}`, once, only after covered utterances are definite and boundary-safe.
- `error`: `{error}`; the emitter includes a default error listener so provider failure never crashes for lack of a consumer.

## Configuration

Reads project `.env`, overriding same-name launch variables:

```dotenv
SOUND2TEXT_API_KEY=
SOUND2TEXT_RESOURCE_ID=
SOUND2TEXT_WS_URL=
SOUND2TEXT_END_WINDOW_MS=800
SOUND2TEXT_COMMAND_SILENCE_MS=1500
SOUND2TEXT_NO_SPEECH_MS=10000
SOUND2TEXT_MAX_COMMAND_MS=60000
SOUND2TEXT_FINAL_WAIT_MS=3000
```

Blank URL selects `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`. Resource ID must be filled for the actual subscription, typically `volc.seedasr.sauc.duration` or `volc.seedasr.sauc.concurrent`; no fake identity is assumed. New API-key authentication uses `X-Api-Key`, `X-Api-Resource-Id`, and a fresh UUID `X-Api-Request-Id`. Legacy App-Key/Access-Key authentication is not enabled.

## Capture semantics and limits

The button boundary is measured in uploaded PCM sample time. The browser flushes its worklet and supplies its exact 16kHz sample checkpoint through the coordinated HTTP interaction request. A checkpoint may trail the service clock by at most 400ms, or lead it by up to 8s while PCM is still in flight on the audio socket. The recognition deadline includes that lead, so confirm is not rejected just because HTTP arrives first. Future PCM is awaited; a bounded 500ms PCM lookback handles already-arrived samples. When the deadline expires, definite text already inside the window is still submitted if the only mismatch is acoustic energy lasting longer than the transcript. Draft text is never submitted. Activity detection clips samples at exact boundaries rather than treating the entire packet as post-button audio. Server-side RMS over roughly 20ms chunks provides lightweight acoustic voice activity; a gap in transcript/network messages is never silence. After voice has started, 1.5 seconds of acoustic silence begins finalization. Cloud `definite` segments may be combined into one instruction. Manual finish and maximum-duration finish use the same stable-tail check. Waiting for speech and maximum duration also have wall-clock bounds; final wait never converts partial text into a command.

If an utterance overlaps the button boundary, timestamped words starting after that boundary are selected. If those word timestamps are absent, capture is safely aborted with an explicit message rather than including pre-button text. Segments wholly in the interval can use full sentence text. Partial ASR revisions replace overlapping drafts even when the provider adjusts their start timestamps. Final segments retire overlapping drafts, and late partials cannot replace finalized segments. Adjacent final sentences remain separate. Continuous public transcript and utterance history are bounded. The service's frame decoder limits both encoded and expanded payloads; upstream backlog stops the stream rather than growing without bounds.

RMS threshold is an initial heuristic rather than semantic intent detection. Quiet speakers, ambient speech and noisy microphones require calibration. Real account permissions, long-session behavior and recognition quality have not been validated without user credentials.

## Verification

`node --test tests/sound2text.test.mjs` uses real local WebSocket servers and generated PCM; it verifies binary framing, authentication headers, packet sizes, partial/final revision, instruction boundaries, acoustic versus network silence, no-speech/final/max timers, pause/error cleanup, buffer bounds and Origin/ownership checks. No paid ASR endpoint is called.
