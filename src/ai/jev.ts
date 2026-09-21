import { TypeSafeClient, choice, noul, type JsonValue } from "@typesafe-ai/sdk";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import type { Observation } from "./observe.js";

const log = logger("jev");

/**
 * Jev (TypeSafe's System One model) makes the fast, typed in-game decisions: given the current
 * game state it picks one action from a fixed set and answers a few yes/no questions, each with a
 * probability. No text generation, so a round trip is short enough to run several times a second.
 *
 * Jev is NOT a chat model and is not served by the relay; it needs TYPESAFE_API_KEY. Without the
 * key the buddy still plays on the reflex policy + coach, and the ops stream says so.
 */

export const JEV_ACTIONS = {
  advance_fire: "Run forward (the direction the level progresses) while firing. Default when the path is clear and the partner is close.",
  follow_partner: "Move toward the human partner to stay within cover range; fire while moving.",
  hold_fire: "Stand still (or lie prone) and fire in the facing direction at an approaching enemy on the same height.",
  aim_up_fire: "Hold UP and fire: an enemy or turret is above the buddy.",
  jump_forward: "Jump toward the level direction: to clear a gap, a low obstacle, a rolling grenade, or an enemy bullet.",
  jump_back: "Jump away from the level direction: an enemy or bullet is about to hit the buddy from the front.",
  retreat: "Walk backwards a few steps while firing: the buddy has run too far ahead of the partner or into a crowd.",
  prone_fire: "Lie prone and fire: bullets are flying at head height, or a low enemy is on the same platform.",
} as const;

export type JevAction = keyof typeof JEV_ACTIONS;

export interface JevDecision {
  action: JevAction;
  confidence: number;
  probabilities: Record<string, number>;
  partnerInDanger: number;
  jumpNow: number;
  latencyMs: number;
  model: string;
}

let client: TypeSafeClient | undefined;

export function jevEnabled(): boolean {
  return Boolean(getConfig().typesafe.apiKey);
}

function getClient(): TypeSafeClient {
  const { typesafe } = getConfig();
  client ??= new TypeSafeClient({ apiKey: typesafe.apiKey, baseURL: typesafe.baseUrl, defaultModel: typesafe.model, timeout: 4000, retry: { maxRetries: 0 } });
  return client;
}

/** Compact state for the model: relative positions, no raw bytes. */
export function jevState(obs: Observation, extra: { coachIntent?: string; recent?: string[] } = {}): { [k: string]: JsonValue } {
  const ai = obs.ai;
  const enemies = obs.enemies
    .map((e) => ({ dx: e.x - ai.x, dy: e.y - ai.y, type: e.type, hp: e.hp }))
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)))
    .slice(0, 6);
  return {
    game: obs.game,
    level_direction: obs.levelDirection,
    buddy: { x: ai.x, y: ai.y, alive: ai.alive, lives: ai.lives, on_ground: ai.onGround, moving: ai.xVel, invincible: ai.invincible },
    partner: obs.human.alive
      ? { alive: true, dx: obs.human.x - ai.x, dy: obs.human.y - ai.y, lives: obs.human.lives, moving: obs.human.xVel }
      : { alive: false, lives: obs.human.lives },
    enemies_relative_to_buddy: enemies,
    screen: { width: obs.screen.width, height: obs.screen.height, note: "x grows to the right, y grows downward" },
    coach_intent: extra.coachIntent ?? "none",
    recent_events: extra.recent ?? [],
  };
}

export async function jevDecide(obs: Observation, extra: { coachIntent?: string; recent?: string[] } = {}): Promise<JevDecision | undefined> {
  if (!jevEnabled()) return undefined;
  const started = Date.now();
  const state = jevState(obs, extra);
  try {
    const res = await getClient().systemOne({
      state,
      questions: {
        action: choice(
          {
            question: "You control `buddy`, the AI teammate (player 2) in a co-op run-and-gun game. Which action should the buddy take for the next half second?",
            rules: [
              "The partner leads; never run more than ~60px ahead of a living partner.",
              "Enemies with dx>0 are in front when level_direction is right.",
              "Jump only when something must be cleared or dodged; needless jumps get the buddy killed.",
              "If coach_intent names a plan, prefer actions consistent with it.",
            ],
          },
          JEV_ACTIONS as Record<JevAction, string>,
        ),
        partner_in_danger: noul("Is an enemy within 40px of the partner, or is the partner about to be overrun?"),
        jump_now: noul("Is a bullet, grenade or enemy about to hit the buddy within the next few frames?"),
      },
    });
    const a = res.answers.action;
    return {
      action: a.choice as JevAction,
      confidence: a.confidence,
      probabilities: a.probabilities as Record<string, number>,
      partnerInDanger: res.answers.partner_in_danger.noul,
      jumpNow: res.answers.jump_now.noul,
      latencyMs: Date.now() - started,
      model: res.model,
    };
  } catch (err) {
    log.warn(`jev request failed: ${String(err)}`);
    return undefined;
  }
}

/** One cheap request to validate the key (used by the doctor). */
export async function jevPing(): Promise<{ ok: boolean; model?: string; error?: string }> {
  if (!jevEnabled()) return { ok: false, error: "TYPESAFE_API_KEY not set" };
  try {
    const res = await getClient().systemOne({ state: "ping", questions: { ok: noul("Is this a ping?") } });
    return { ok: true, model: res.model };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
