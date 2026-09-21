import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { createTextSession, parseJsonObject, promptForText, type TextSession } from "../agent/session.js";
import { getModels } from "../runtimeConfig.js";
import type { GameProfile } from "../games/registry.js";
import { actionsFor, type JevAction } from "./jev.js";
import type { Observation } from "./observe.js";

const log = logger("coach");

/**
 * The coach is a pi session (relay LLM) that watches the game at a slow cadence: every few seconds
 * it gets a text summary (and, for vision models, a screenshot) and answers with a short plan and a
 * line of commentary. The plan biases Jev/the reflex policy; the commentary goes to the danmaku.
 */

export interface CoachAdvice {
  intent: JevAction | "auto";
  plan: string;
  say: string;
  model: string;
  latencyMs: number;
}

export function coachSystemPrompt(game: GameProfile, lang: string): string {
  const actions = Object.entries(actionsFor(game))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return `You are the strategist and commentator of an AI teammate ("the buddy", player ${game.players.ai}) playing ${game.title}${game.titleLocal ? ` (${game.titleLocal})` : ""} together with a human (player ${game.players.human}).

About the game:
${game.coachBrief}

Every few seconds you receive a summary of what happened (positions, enemies, deaths, what the buddy has been doing) and sometimes a screenshot. Reply with ONE JSON object and nothing else:
{"intent": "<one of the intents below or auto>", "plan": "<what the buddy should do for the next few seconds, one sentence, English>", "say": "<one short line of live commentary for the human player, max 40 characters, in language ${lang}>"}

Intents:
${actions}
- auto: let the fast policy decide on its own

Commentary style: warm, playful arcade-buddy voice, second person to the human, react to what just happened (a death, a boss, a power-up, the human doing well), occasionally give a concrete tip. Never repeat the previous line. No emojis except at most one per line.`;
}

export class Coach {
  private session: TextSession | undefined;
  private busy = false;
  private lastSay = "";
  readonly model: string;

  constructor(
    private readonly game: GameProfile,
    private readonly lang: string,
  ) {
    this.model = getModels().coachModel;
  }

  private async ensure(): Promise<TextSession> {
    this.session ??= await createTextSession("coach", coachSystemPrompt(this.game, this.lang), { thinking: "off" });
    return this.session;
  }

  get supportsVision(): boolean {
    return getConfig().ai.coachVision;
  }

  /** One round: summary (+ optional jpeg) → advice. Returns undefined while a previous round is still running. */
  async advise(summary: string, obs: Observation, shotJpegBase64?: string): Promise<CoachAdvice | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    const started = Date.now();
    try {
      const session = await this.ensure();
      const prompt = `${summary}\n\nCurrent snapshot: phase=${obs.phase}, level=${obs.level}, buddy=(${obs.ai.x},${obs.ai.y}) lives=${obs.ai.lives} alive=${obs.ai.alive}, partner=(${obs.human.x},${obs.human.y}) lives=${obs.human.lives} alive=${obs.human.alive}, enemies=${obs.enemies.length}.\nPrevious commentary line (do not repeat): "${this.lastSay}"\nReply with the JSON object only.`;
      const images = shotJpegBase64 && this.supportsVision ? [{ mediaType: "image/jpeg", data: shotJpegBase64 }] : undefined;
      const raw = await promptForText(session, prompt, images);
      const parsed = parseJsonObject<{ intent?: string; plan?: string; say?: string }>(raw) ?? {};
      const intent = (parsed.intent && parsed.intent in actionsFor(this.game) ? parsed.intent : "auto") as JevAction | "auto";
      const say = String(parsed.say ?? "").trim().slice(0, 80);
      if (say) this.lastSay = say;
      return { intent, plan: String(parsed.plan ?? "").trim().slice(0, 200), say, model: this.model, latencyMs: Date.now() - started };
    } catch (err) {
      log.warn(`coach round failed: ${String(err)}`);
      return undefined;
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = undefined;
  }
}
