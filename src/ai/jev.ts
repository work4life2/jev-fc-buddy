import { TypeSafeClient, choice, noul, type JsonValue } from "@typesafe-ai/sdk";
import { getConfig } from "../config.js";
import { logger } from "../log.js";
import { genreOf, type GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";
import type { EdgeInfo, GapInfo } from "./policy.js";
import { describeHop, type RouteInfo } from "./route.js";
import { TANK_INTENTS, tankSummary, type TankIntent } from "./tankPolicy.js";

const log = logger("jev");

/**
 * Jev (TypeSafe's System One model) makes the fast, typed in-game decisions: given the current
 * game state it picks one action from a fixed set and answers a few yes/no questions, each with a
 * probability. No text generation, so a round trip is short enough to run several times a second.
 *
 * Jev is not a chat model: it is reached through TypeSafe's System One API, which OpenRouter mirrors
 * at <relay>/v1/systemone on the same key (bare ids like `jev-latest` map to `~typesafe/jev-latest`).
 * Without any key the buddy still plays on the reflex policy, and the ops stream says so.
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

/** Either action set: the run-and-gun moves or the tank intents (see tankPolicy.ts). */
export type JevAction = keyof typeof JEV_ACTIONS | TankIntent;

/** The action set Jev chooses from for a game. */
export function actionsFor(game: GameProfile): Record<string, string> {
  return genreOf(game) === "tank" ? TANK_INTENTS : JEV_ACTIONS;
}

export interface JevDecision {
  action: JevAction;
  confidence: number;
  probabilities: Record<string, number>;
  partnerInDanger: number;
  jumpNow: number;
  proneNow: number;
  sprintNow: number;
  /** Tank genre only. */
  baseInDanger: number;
  latencyMs: number;
  model: string;
  /** Tokens billed for this request (from the response). */
  usage: { input: number; output: number };
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
export interface JevExtra {
  coachIntent?: string;
  recent?: string[];
  gap?: GapInfo;
  /** The platform the buddy stands on ends ahead (learned map). */
  edge?: EdgeInfo;
  /** Learned kill zones near the buddy, already relative to it. */
  dangers?: Array<{ from_px: number; to_px: number; note: string }>;
  /** Per-action descriptions computed for this very state (src/ai/criteria.ts); the static set otherwise. */
  criteria?: Record<keyof typeof JEV_ACTIONS, string>;
  /** What the reflex policy would do right now, and why. `reflex` = a survival move Jev cannot override. */
  plan?: { intent: string; why: string; reflex: boolean };
  /** Planned route over the learned platform map. */
  route?: RouteInfo;
  /** Level briefing from the profile. */
  stage?: { kind: string; name?: string; objective: string; tips?: string[] };
}

/** The profile's briefing for the current level (kind, objective, tips). */
export function stageBrief(game: GameProfile, obs: Observation): JevExtra["stage"] {
  const st = game.stages?.[String(obs.level)];
  if (!st) return undefined;
  if (typeof st === "string") return { kind: obs.corridor ? "corridor" : obs.levelDirection === "up" ? "vertical" : "side", objective: st };
  return st;
}

/** Learned kill zones within reach of the buddy, as relative distances plus the lesson. */
export function dangersNear(game: GameProfile, obs: Observation): JevExtra["dangers"] {
  const zones = game.learned?.levels[String(obs.level)]?.killZones ?? [];
  const me = obs.ai.levelX;
  return zones
    .filter((z) => z.x2 >= me - 64 && z.x1 <= me + 160 && obs.ai.y >= z.yMin - 24 && obs.ai.y <= z.yMax + 24)
    .slice(0, 3)
    .map((z) => ({ from_px: Math.round(z.x1 - me), to_px: Math.round(z.x2 - me), note: `${z.count} deaths by ${z.cause} from ${z.from}: ${z.advice}` }));
}

export function jevState(obs: Observation, extra: JevExtra = {}): { [k: string]: JsonValue } {
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
    ledge_ahead: extra.edge
      ? { ends_in_px: Math.round(extra.edge.dist), ground_below: extra.edge.dropOk, next_platform: extra.edge.landing ? { dx: Math.round(extra.edge.landing.dx), dy: extra.edge.landing.dy, note: "reachable with a jump from the edge" } : "none known: walking off means falling" }
      : "none within 48px",
    known_dangers: extra.dangers && extra.dangers.length ? extra.dangers : "none learned nearby",
    stage: extra.stage ? { kind: extra.stage.kind, name: extra.stage.name ?? `level ${obs.level + 1}`, objective: extra.stage.objective, tips: extra.stage.tips ?? [] } : { kind: obs.corridor ? "corridor" : obs.levelDirection, name: `level ${obs.level + 1}` },
    route: extra.route ? { next: describeHop(extra.route, ai.levelX), hops_after: extra.route.hops, map_ends_in_px: Math.round(extra.route.endX - ai.levelX) } : "no mapped route from here (unknown ground or a corridor)",
    big_targets: obs.enemies.filter((e) => e.hp > 1 && (e.category === "hostile" || e.category === "obstacle")).slice(0, 4).map((e) => ({ kind: e.category, dx: e.x - ai.x, dy: e.y - ai.y, hp: e.hp })),
    plan: extra.plan ? { action: extra.plan.intent, why: extra.plan.why, kind: extra.plan.reflex ? "reflex (a bullet or a hazard: this happens regardless of your answer)" : "positioning/targeting proposal: pick it unless you see a better move" } : "none",
    objects_relative_to_buddy: enemies,
    legend: {
      kind: "hostile = enemy that can be shot; projectile = enemy bullet/grenade, cannot be shot, must be dodged; item = weapon power-up worth collecting (a flying capsule must be shot first); hazard = bridge that explodes under the buddy, never stand still on or next to it",
      dx_dy: "pixels from the buddy; dx > 0 is ahead when level_direction is right; dy < 0 is above",
      moving: "pixels per tick (about 1/12 s); a projectile with moving_x opposite in sign to dx is coming at the buddy",
      known_dangers: "places (from_px..to_px ahead of the buddy, negative = behind) where the buddy died repeatedly in training, with the lesson",
    },
    screen: { width: obs.screen.width, height: obs.screen.height },
    coach_intent: extra.coachIntent ?? "none",
    recent_events: extra.recent ?? [],
  };
}

/** Tank genre: which intent should drive the buddy for the next second, plus two danger flags. */
async function jevDecideTank(game: GameProfile, obs: Observation, extra: { coachIntent?: string; recent?: string[] }): Promise<JevDecision | undefined> {
  const started = Date.now();
  const state: { [k: string]: JsonValue } = {
    game: obs.game,
    ...(tankSummary(obs, game) as { [k: string]: JsonValue }),
    partner: obs.human.alive ? { alive: true, dx: obs.human.x - obs.ai.x, dy: obs.human.y - obs.ai.y, lives: obs.human.lives } : { alive: false, lives: obs.human.lives },
    legend: {
      dx_dy: "pixels from the buddy's tank; dy < 0 is above (toward the enemy spawn points), the base is at the bottom",
      enemies: "sorted nearest first; a spawning enemy cannot be hit yet; distance_to_base below 96 means it threatens the eagle",
      enemy_shells: "heading = direction of flight; a shell whose heading points at the buddy on the same row/column is about to hit",
    },
    coach_intent: extra.coachIntent ?? "none",
    recent_events: extra.recent ?? [],
  };
  try {
    const res = await getClient().systemOne({
      state,
      questions: {
        action: choice(
          {
            question: "You control `buddy`, the AI teammate in a two-player top-down tank game. Which intent should drive the buddy for the next second?",
            rules: [
              "Survival first: the fast reflex layer already dodges and shoots down shells; you pick where the buddy goes.",
              "The base (eagle) must not be shot: an enemy with distance_to_base below 96 → defend_base.",
              "An item on the field within ~120px and no enemy shell nearby → collect_item (grenade, tank and helmet are worth a longer trip).",
              "The partner has an enemy within 48px or is low on lives → support_partner.",
              "Two or more enemies facing the buddy's lanes → evade; otherwise engage.",
              "hold_fire only when the buddy sits in a good lane and enemies are coming to it.",
              "If coach_intent names a plan, prefer actions consistent with it.",
            ],
          },
          TANK_INTENTS as Record<TankIntent, string>,
        ),
        partner_in_danger: noul("Is an enemy tank or an enemy shell within 40px of the partner?"),
        base_in_danger: noul("Is an enemy tank closer than 64px to the base, or an enemy shell flying toward it?"),
      },
    });
    const a = res.answers.action;
    return {
      action: a.choice as JevAction,
      confidence: a.confidence,
      probabilities: a.probabilities as Record<string, number>,
      partnerInDanger: res.answers.partner_in_danger.noul,
      jumpNow: 0,
      proneNow: 0,
      sprintNow: 0,
      baseInDanger: res.answers.base_in_danger.noul,
      latencyMs: Date.now() - started,
      model: res.model,
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
    };
  } catch (err) {
    log.warn(`jev request failed: ${String(err)}`);
    return undefined;
  }
}

export async function jevDecide(game: GameProfile, obs: Observation, extra: JevExtra = {}): Promise<JevDecision | undefined> {
  if (!jevEnabled()) return undefined;
  if (genreOf(game) === "tank" && obs.tank) return jevDecideTank(game, obs, extra);
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
              "Priority order: 1) stay alive, 2) keep the partner alive (cover them, shoot what threatens them), 3) progress. One touch from a hostile or a projectile kills; a dead buddy helps nobody.",
              "Enemy shots are aimed at where the buddy stands: standing still under a shooter on another height (dy beyond ±28) gets the buddy killed; keep changing position (advance_fire or retreat), never hold_fire there.",
              "A projectile flying level at the buddy's body or head (dy between -30 and 0, closing): prone_fire. A level shot at foot height (dy 1..24): jump_forward. A rising or diving shot (moving_y larger than moving_x): step sideways (advance_fire/retreat), never prone into it, never jump into it.",
              "Never jump when a projectile is anywhere in the air nearby: a jump lasts a second and cannot be steered.",
              "ledge_ahead: with no next_platform and no ground_below, walking off means death → stop (hold_fire) or go back; with a next_platform, jump_forward from the edge.",
              "pit_ahead: cross a bridge only together with the partner (advance_fire while the partner is on it or about to step on it); never stop on it; if the partner is already beyond it and it is gone, hold_fire at the edge.",
              "known_dangers: follow the lesson given for a zone the buddy is in or about to enter.",
              "A hostile ahead within 100px at the same height that is running at the buddy: hold_fire until it is gone; do not walk into it. Hostiles near the partner come first when the buddy itself is safe.",
              "The partner leads; never run more than ~60px ahead of a living partner. Prefer follow_partner when the partner is far ahead.",
              "Items are good: a weapon item within reach and no hostile nearby → move toward it (advance_fire if ahead, retreat if behind).",
              "stage.objective says what this level is about; route.next is the mapped way on (the high road on level 1: the water and low ledges dead-end). Follow the route unless something is shooting at the hop point right now.",
              "big_targets (hp above 1) are walls, cannons, sensors, cores: they die to sustained fire from a spot where their shots miss. In a corridor stage, advance_fire/retreat are steps right/left along the floor line, hold_fire fires into the screen at the target above, aim_up_fire runs into an opened wall; line up (dx near 0) under a target and hold_fire.",
              "plan is the reflex policy's own proposal with its reason. Agree with it (pick the same action) unless the state shows a clearly better move; never pick a jump or prone against a plan that is walking to a ledge.",
            ],
          },
          (extra.criteria ?? JEV_ACTIONS) as Record<JevAction, string>,
        ),
        partner_in_danger: noul("Is a hostile within 40px of the partner, or is the partner about to be overrun?"),
        jump_now: noul("Is a LOW, level-flying projectile about to reach the buddy's feet (and no other projectile is in the air nearby), so that jumping right now is the way to survive?"),
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
      baseInDanger: 0,
      latencyMs: Date.now() - started,
      model: res.model,
      usage: { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0 },
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
