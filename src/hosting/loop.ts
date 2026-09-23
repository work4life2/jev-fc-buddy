import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { notify } from "../notify.js";
import { sleep } from "../util/exec.js";
import { termix, type WatchEvent } from "../termix/client.js";
import { handleChatMessage } from "../jobs/chat.js";
import { claimExpiredDeliveries, pollNewOrders, processOrder, sweepOrders } from "../jobs/orderWorker.js";

const log = logger("hosting");

/**
 * The Termix hosting loop: `aacp-watch.mjs wait` blocks until a buyer message / funded order
 * appears (its polling is what keeps the agent ONLINE), then events are dispatched. Orders are
 * processed one at a time (minting a code takes seconds; the on-chain steps dominate).
 */
export class HostingLoop {
  private stopped = false;
  private running = new Map<string, Promise<void>>();
  private queue: string[] = [];
  private lastSweep = 0;

  constructor(private readonly agentId: string) {}

  stop() {
    this.stopped = true;
  }

  private enqueueOrder(orderId: string, reason: string) {
    if (this.running.has(orderId) || this.queue.includes(orderId)) return;
    log.info(`order ${orderId}: queued (${reason})`);
    this.queue.push(orderId);
    this.pump();
  }

  private pump() {
    while (this.running.size < 1 && this.queue.length) {
      const orderId = this.queue.shift()!;
      const p = processOrder(orderId)
        .then(() => undefined)
        .catch((err) => log.error(`order ${orderId}: ${String(err)}`))
        .finally(() => {
          this.running.delete(orderId);
          this.pump();
        });
      this.running.set(orderId, p);
    }
  }

  private async dispatch(ev: WatchEvent) {
    switch (ev.type) {
      case "chat.message":
        handleChatMessage(ev).catch((err) => log.error(`chat ${ev.conversationId}: ${String(err)}`));
        break;
      case "order.funded":
        if (ev.orderId) this.enqueueOrder(String(ev.orderId), "order.funded event");
        break;
      case "hosting.handoff":
        log.info(ev.what ?? "cloud hosting paused; this runtime answers now");
        break;
      default:
        log.info(`event ${ev.type}`, ev);
        // Redo requests and challenges arrive as order/dispute events; processOrder reads the
        // order's real status and routes to handleRedo / submitDisputeEvidence.
        if (ev.orderId && /^(order|dispute)\./.test(ev.type)) this.enqueueOrder(String(ev.orderId), `${ev.type} event`);
    }
  }

  private async sweep() {
    const { jobs } = getConfig();
    if (Date.now() - this.lastSweep < jobs.sweepIntervalSeconds * 1000) return;
    this.lastSweep = Date.now();
    try {
      for (const id of await sweepOrders()) this.enqueueOrder(id, "sweep");
      const claimed = await claimExpiredDeliveries();
      if (claimed) log.info(`claimed ${claimed} expired delivery window(s)`);
    } catch (err) {
      log.warn(`sweep failed: ${String(err)}`);
    }
  }

  /** Fast lane for new orders, beside the watcher (which never announces PENDING_ACCEPT). */
  private async pollOrders() {
    while (!this.stopped) {
      try {
        for (const id of await pollNewOrders()) this.enqueueOrder(id, "order poll");
      } catch (err) {
        log.warn(`order poll failed: ${String(err)}`);
      }
      await sleep(getConfig().jobs.orderPollSeconds * 1000);
    }
  }

  async run(): Promise<void> {
    const tx = termix();
    log.info(`hosting agent ${this.agentId} on chain ${getConfig().termix.chain}`);
    await tx.ensureRuntimeToken();
    try {
      await tx.hostingOff(this.agentId);
    } catch {
      /* cloud hosting may not be configured */
    }
    await notify("hosting.started", { agentId: this.agentId });
    const orderPoll = this.pollOrders();
    let failures = 0;
    while (!this.stopped) {
      await this.sweep();
      try {
        const res = await tx.wait(this.agentId, 120, 10);
        failures = 0;
        for (const ev of res.events) await this.dispatch(ev);
        if (res.errors?.length) log.warn("watch reported source errors", res.errors);
      } catch (err) {
        failures++;
        const backoff = Math.min(300, 10 * 2 ** Math.min(failures, 5));
        log.error(`watch failed (${failures}): ${String(err)} — retrying in ${backoff}s`);
        if (failures === 3) await notify("hosting.degraded", { error: String(err) });
        await sleep(backoff * 1000);
      }
    }
    await Promise.allSettled([orderPoll, ...this.running.values()]);
    await notify("hosting.stopped", { agentId: this.agentId });
  }
}
