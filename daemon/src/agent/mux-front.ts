/**
 * Front door 1: the mux `kind:"agent"` stream handler (browser over RTC or
 * relay mux). Registered through `setAgentStreamHandler` (mux-host), which
 * runs the per-kind seed gate BEFORE this is reached: only a browser channel
 * whose device grant carries `dpk` = this daemon's key gets here, never an
 * origin / fleet (`consumer:"daemon"`) peer. On the relay mux the `stream`
 * handed in is already the Noise_IK-secured wrapper (`serveSecureAgentStream`
 * in mux-host), so everything below reads and writes plaintext while the
 * relay forwards ciphertext; on RTC, DTLS bound to the daemon key is the E2E.
 */
import { parseStreamCtrlPayload } from "@openllmsh/protocol";
import { decodeJsonPayload, encodeJsonPayload } from "@openllmsh/tunnel/codec";
import type { TServeAgent } from "@openllmsh/tunnel/streams";
import {
  acceptAgentStream,
  pumpAgentCommands,
  sendAgentEvent,
} from "@openllmsh/tunnel/streams";
import type { TAgentDispatcher } from "./dispatcher";

export const createAgentStreamHandler =
  (dispatcher: TAgentDispatcher): TServeAgent =>
  (stream) => {
    let ended = false;
    const connection = dispatcher.connect({
      send: (event) => sendAgentEvent(stream, event),
      replayDone: () => {
        stream.sendCtrl(encodeJsonPayload({ t: "replay_done" }));
      },
      end: (code) => {
        if (ended) return;
        ended = true;
        if (code === undefined) stream.end();
        else stream.reset(encodeJsonPayload({ code }));
      },
    });
    acceptAgentStream(stream);
    pumpAgentCommands(stream, connection.command, connection.invalid);
    stream.onCtrl((payload) => {
      // Echo consumer heartbeats so its optional liveness timeout sees traffic.
      const ctrl = parseStreamCtrlPayload(decodeJsonPayload(payload));
      if (ctrl?.t === "heartbeat" && !ended) {
        stream.sendCtrl(encodeJsonPayload({ t: "heartbeat" }));
      }
      if (ctrl?.t === "focus") connection.focus();
      if (ctrl?.t === "blur") connection.blur();
    });
    const detach = (): void => {
      ended = true;
      connection.detach();
    };
    stream.onReset(() => {
      detach();
    });
    stream.onEnd(() => {
      // The consumer half-closed: `detach()` on the consumer side. The engine
      // session keeps running for a later attach.
      detach();
      stream.end();
    });
  };
