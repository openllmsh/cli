import type { TDaemonCommand, TDaemonCommandAck } from "@openllmsh/protocol";
import { daemonCommandScheduler } from "./command-scheduler";
import { loginSlot } from "./delegation/login-flow";

/** Both transports use the SAME admission lanes. Transport-specific delivery stays outside. */
export const scheduleDaemonCommand = async (
  command: TDaemonCommand,
  run: () => Promise<void>,
): Promise<TDaemonCommandAck | null> => {
  const scheduled = await daemonCommandScheduler.schedule(command, run);
  if (scheduled.admitted) return null;
  const slug = scheduled.slug;
  const flow = slug !== undefined ? loginSlot(slug).flow() : null;
  return scheduled.reason === "resurface"
    ? {
        id: command.id,
        status: "done",
        result: {
          connected: false,
          pending: true,
          ...(flow !== null ? { flow_id: flow.flowId } : {}),
          detail: "sign-in already in progress",
        },
      }
    : {
        id: command.id,
        status: "error",
        result: {
          error: scheduled.reason,
          retryable: true,
          ...(slug !== undefined ? { slug } : {}),
        },
      };
};
