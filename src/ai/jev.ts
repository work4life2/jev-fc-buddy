import { TypeSafeClient, choice, noul, type JsonValue } from "@typesafe-ai/sdk";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import type { Observation } from "./observe.js";
import type { GapInfo } from "./policy.js";

const log = logger("jev");

/**
 * Jev (TypeSafe's System One model) makes the fast, typed in-game decisions: given the current
 * game state it picks one action from a fixed set and answers a few yes/no questions, each with a
 * probability. No text generation, so a round trip is short enough to run several times a second.
 *
 * Jev is not a chat model: it is reached through TypeSafe's System One API, which OpenRouter mirrors
 * at <relay>/v1/systemone on the same key (bare ids like `jev-latest` map to `~typesafe/jev-latest`).
 * Without any key the buddy still plays on the reflex policy + coach, and the ops stream says so.
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
  proneNow: number;
  sprintNow: number;
  latencyMs: number;
  model: string;
}

let client: TypeSafeClient | undefined;

export function jevEnabled(): boolean {
  return Boolean(getConfig().typesafe.apiKey);
}

function getClient(): TypeSafeClient {
  const { typesafe } = getConfig();
  client ??= new TypeSafeClient({ apiKey: typesafe.apiKey, baseURL: typesafe.baseUrl, defaultModel: typesafe.model, timeout: 2500, retry: { maxRetries: 0 } });
  return client;
}

/** Compact state for the model: relative positions, no raw bytes. */
export function jevState(obs: Observation, extra: { coachIntent?: string; recent?: string[]; gap?: GapInfo } = {}): { [k: string]: JsonValue } {
  const ai = obs.ai;
  const sorted = obs.enemies
    .map((e) => ({ kind: e.category, dx: e.x - ai.x, dy: e.y - ai.y, moving_x: e.vx, moving_y: e.vy, hp: e.hp }))
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  const enemies = sorted.filter((e) => e.kind !== "obstacle").slice(0, 7);
  // hazard = ground that gives way; it is listed so Jev never picks hold_fire on it
  return {
    game: obs.game,
    level_direction: obs.levelDirection,
    buddy: { x: ai.x, y: ai.y, alive: ai.alive, lives: ai.lives, on_ground: ai.onGround, moving: ai.xVel, invincible: ai.invincible, weapon: ai.weapon },
    partner: obs.human.alive
      ? { alive: true, dx: obs.human.x - ai.x, dy: obs.human.y - ai.y, lives: obs.human.lives, moving: obs.human.xVel }
      : { alive: false, lives: obs.human.lives },
    pit_ahead: extra.gap
      ? { starts_in_px: Math.round(extra.gap.dxStart), ends_in_px: Math.round(extra.gap.dxEnd), width_px: extra.gap.width, buddy_on_it: extra.gap.inside, partner_is: extra.gap.partner, note: "a bridge that explodes as it is crossed; a player who arrives after it is gone falls to death; it is too wide to jump" }
      : "none within 200px",
    objects_relative_to_buddy: enemies,
    legend: {
      kind: "hostile = enemy that can be shot; projectile = enemy bullet/grenade, cannot be shot, must be dodged; item = weapon power-up worth collecting (a flying capsule must be shot first); hazard = bridge that explodes under the buddy, never stand still on or next to it",
      dx_dy: "pixels from the buddy; dx > 0 is ahead when level_direction is right; dy < 0 is above",
      moving: "pixels per tick (about 1/12 s); a projectile with moving_x opposite in sign to dx is coming at the buddy",
    },
    screen: { width: obs.screen.width, height: obs.screen.height },
    coach_intent: extra.coachIntent ?? "none",
    recent_events: extra.recent ?? [],
  };
}

export async function jevDecide(obs: Observation, extra: { coachIntent?: string; recent?: string[]; gap?: GapInfo } = {}): Promise<JevDecision | undefined> {
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
              "One touch from a hostile or a projectile kills the buddy; survival first, progress second.",
              "A projectile at roughly the buddy's height (dy between -30 and 10) closing in within 60px: prone_fire (jump_forward only if it is low, dy > 5).",
              "A hostile ahead within 100px at the same height: hold_fire until it is gone; do not walk into it.",
              "The partner leads; never run more than ~60px ahead of a living partner. Prefer follow_partner when the partner is far ahead.",
              "pit_ahead: cross a bridge only together with the partner (advance_fire while the partner is on it or about to step on it); never stop on it; if the partner is already beyond it and it is gone, hold_fire at the edge.",
              "Items are good: a weapon item within reach and no hostile nearby → move toward it (advance_fire if ahead, retreat if behind).",
              "Jump only when something must be cleared or dodged; needless jumps get the buddy killed.",
              "If coach_intent names a plan, prefer actions consistent with it.",
            ],
          },
          JEV_ACTIONS as Record<JevAction, string>,
        ),
        partner_in_danger: noul("Is a hostile within 40px of the partner, or is the partner about to be overrun?"),
        jump_now: noul("Is a LOW projectile or a hostile about to touch the buddy so that jumping right now is the only way to survive?"),
        prone_now: noul("Is a projectile at the buddy's body height about to hit it, so that lying prone right now avoids it?"),
        sprint_now: noul("Should the buddy run forward at full speed right now, e.g. to cross the bridge with the partner or to keep up with a partner who is walking away?"),
      },
    });
    const a = res.answers.action;
    return {
      action: a.choice as JevAction,
      confidence: a.confidence,
      probabilities: a.probabilities as Record<string, number>,
      partnerInDanger: res.answers.partner_in_danger.noul,
      jumpNow: res.answers.jump_now.noul,
      proneNow: res.answers.prone_now.noul,
      sprintNow: res.answers.sprint_now.noul,
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
