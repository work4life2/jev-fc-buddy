import type { GameProfile } from "../games/registry.js";
import type { EnemyObs, Observation } from "./observe.js";
import type { JevAction } from "./jev.js";

/**
 * The reflex policy: turns an intent (from Jev, the coach, or its own heuristics) plus the current
 * observation into a set of held buttons for the AI's controller. Runs on every tick with zero
 * latency, so the buddy keeps moving sensibly between model answers.
 *
 * Two layers: `survivalIntent` are hard rules that always win (dodge a projectile, shoot what is
 * about to touch us); `heuristicIntent` is the default plan when no model has a fresh opinion.
 */

export type Button = "A" | "B" | "SELECT" | "START" | "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface Action {
  hold: Button[];
  /** Buttons to pulse (re-pressed every few frames) instead of holding — semi-auto fire. */
  turbo: Button[];
  tag: string;
  reason: string;
}

/** Jev's action set plus policy-internal moves Jev does not need to know about. */
export type Intent = JevAction | "auto" | "aim_diag_fire";

export const IDLE: Action = { hold: [], turbo: [], tag: "idle", reason: "" };

export interface PolicyMemory {
  lastX: number;
  stillSince: number;
  lastJumpAt: number;
  /** Direction the buddy is believed to face (last horizontal input), +1 right / -1 left. */
  facing: 1 | -1;
  /** While set, a "turn" input is being held so the sprite faces the other way. */
  turnUntil: number;
  proneSince: number;
  /** Level-x positions where ground that gives way was seen (bridges). Gaps stay after the object is gone. */
  gaps: number[];
  level: number;
}

export function newMemory(): PolicyMemory {
  return { lastX: -1, stillSince: 0, lastJumpAt: 0, facing: 1, turnUntil: 0, proneSince: 0, gaps: [], level: -1 };
}

/** Remember hazards in level coordinates so the gap they leave behind is still known. */
export function rememberHazards(obs: Observation, mem: PolicyMemory): void {
  if (mem.level !== obs.level) {
    mem.level = obs.level;
    mem.gaps = [];
  }
  for (const e of obs.enemies) {
    if (e.category !== "hazard") continue;
    const lx = obs.levelScrollX + e.x;
    if (!mem.gaps.some((g) => Math.abs(g - lx) < 24)) mem.gaps.push(lx);
  }
}

type Rel = EnemyObs & { dx: number; dy: number; dist: number; approaching: boolean };

function fwdBack(obs: Observation): { fwd: Button; back: Button; sign: 1 | -1 } {
  // Vertical levels still move left/right; "forward" then means toward the partner's side.
  if (obs.levelDirection === "up" && obs.human.alive) return obs.human.x >= obs.ai.x ? { fwd: "RIGHT", back: "LEFT", sign: 1 } : { fwd: "LEFT", back: "RIGHT", sign: -1 };
  return { fwd: "RIGHT", back: "LEFT", sign: 1 };
}

/** Enemies relative to the buddy, in level-forward coordinates (dx > 0 = ahead). */
export function relative(obs: Observation, sign: 1 | -1): Rel[] {
  const ai = obs.ai;
  return obs.enemies
    .map((e) => {
      const dx = (e.x - ai.x) * sign;
      const dy = e.y - ai.y;
      const vxRel = e.vx * sign; // relative to the buddy already (scroll cancelled)
      // Approaching: |dx| shrinking; unknown/slow velocity counts as approaching when already close
      // (a bullet is often seen only once before it is on us).
      const approaching = (dx > 0 && vxRel < 0) || (dx < 0 && vxRel > 0) || (Math.abs(dx) < 40 && Math.abs(e.vx) <= 1);
      return { ...e, dx, dy, dist: Math.abs(dx) + Math.abs(dy), approaching };
    })
    .sort((a, b) => a.dist - b.dist);
}

/**
 * Hard survival rules. Returns undefined when nothing is urgent. These override Jev and the coach
 * because a 250 ms model round trip is too slow for a bullet 40 px away.
 */
export function survivalIntent(game: GameProfile, obs: Observation, mem: PolicyMemory, now: number): { intent: Intent; why: string } | undefined {
  const r = game.reflex;
  const ai = obs.ai;
  const { sign } = fwdBack(obs);
  const rel = relative(obs, sign);
  const dodge = r.dodgeDistance ?? 64;

  // 1. Projectile about to hit: lie prone (the standard Contra dodge: bullets fly over a prone body)
  //    unless it is low, then jump. Only from the ground; mid-air we cannot change anything.
  // 0. Ground that gives way (exploding bridge). On it: keep moving. Ahead of it: sprint so we cross
  //    together with the partner (a lagging player finds the bridge already gone). Where one used
  //    to be and nothing is left: jump the gap from its edge (best effort).
  rememberHazards(obs, mem);
  const hazard = rel.find((e) => e.category === "hazard" && Math.abs(e.dx) < 40 && e.dy > -8 && e.dy < 48);
  if (hazard) {
    if (mem.stillSince && now - mem.stillSince > 250 && ai.onGround && now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: `hazard underfoot (dx ${hazard.dx}) → jump clear` };
    return { intent: "advance_fire", why: `hazard underfoot (dx ${hazard.dx}) → keep moving` };
  }
  let low: Rel | undefined; // a bullet that will arrive below the waist: jump it
  let body: Rel | undefined; // a bullet at body/head height: lie under it
  for (const e of rel) {
    if (e.category !== "projectile") continue;
    const passing = Math.abs(e.dx) < 28; // already next to us: stay down until it is gone
    if (Math.abs(e.dx) > dodge || (!e.approaching && !passing)) continue;
    // Where will it be (vertically) when it reaches us? Diagonal shots from snipers above start high.
    const ticks = Math.abs(e.dx) / Math.max(Math.abs(e.vx), 3); // a bullet next to us arrives now, whatever vx says
    const yAt = e.dy + e.vy * Math.min(ticks, 12);
    if (yAt < -30 || yAt > 22) continue; // will pass over the head or under the feet
    if (yAt > 10 && Math.abs(e.dx) > 12) low ??= { ...e, dy: yAt };
    else body ??= { ...e, dy: yAt };
  }
  if (low || body) {
    if (!ai.onGround) return undefined; // mid-air: nothing to be done
    // With anything at body height prone wins (a jump would lift us into it); otherwise hop the low one.
    if (body) return { intent: "prone_fire", why: `bullet incoming (dx ${body.dx}, y@ ${body.dy.toFixed(0)})` };
    if (now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: `low shot (dx ${low!.dx}, y@ ${low!.dy.toFixed(0)}) → jump` };
    return { intent: "prone_fire", why: `low shot, cannot jump yet → prone (dx ${low!.dx})` };
  }
  // 1b. A hostile dropping onto us from a ledge above (soldiers jump down): step back out from under it.
  const diver = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 28 && e.dy < -12 && e.dy > -56 && e.vy > 0);
  if (diver) {
    if (ai.onGround && now - mem.lastJumpAt > 900) return { intent: "jump_back", why: `hostile dropping in (dx ${diver.dx}, dy ${diver.dy}) → hop back` };
    return { intent: "retreat", why: `hostile dropping in (dx ${diver.dx}, dy ${diver.dy})` };
  }
  // 1c. A shot coming up from below (pill box under a ledge): sidestep, prone will not help.
  const fromBelow = rel.find((e) => e.category === "projectile" && Math.abs(e.dx) < 24 && e.dy > 8 && e.dy < 64 && (e.vy < 0 || e.vy === 0));
  if (fromBelow) return { intent: fromBelow.dx <= 0 ? "advance_fire" : "retreat", why: `shot from below (dx ${fromBelow.dx}, dy ${fromBelow.dy}) → sidestep` };
  // 2. Hostile in touching range at our height: face it and shoot; if it is about to touch, hop back.
  const touch = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < r.closeDistance && Math.abs(e.dy) < 20);
  if (touch) {
    if (touch.approaching && ai.onGround && now - mem.lastJumpAt > 900 && Math.abs(touch.dx) < 20) return { intent: "jump_back", why: `hostile about to touch (dx ${touch.dx}) → hop back` };
    if (touch.dx < 0) return { intent: "retreat", why: `hostile behind (dx ${touch.dx})` };
    return { intent: "hold_fire", why: `hostile close ahead (dx ${touch.dx})` };
  }
  // 2b. Bridge ahead: sprint to cross with the partner. Gap where a bridge was: jump from its edge.
  const hazardAhead = rel.find((e) => e.category === "hazard" && e.dx >= 40 && e.dx < 220 && Math.abs(e.dy) < 48);
  if (hazardAhead && !rel.some((e) => e.category === "hostile" && e.dx > 0 && e.dx < hazardAhead.dx && Math.abs(e.dy) < 24)) return { intent: "advance_fire", why: `bridge ahead (dx ${hazardAhead.dx}) → sprint to cross with the partner` };
  const myLx = obs.levelScrollX + ai.x;
  const gapAhead = mem.gaps.map((g) => (g - myLx) * sign).find((d) => d > 0 && d < 60);
  if (gapAhead !== undefined && !rel.some((e) => e.category === "hazard" && Math.abs(e.dx - gapAhead) < 40)) {
    if (gapAhead < 34 && ai.onGround && now - mem.lastJumpAt > 800) return { intent: "jump_forward", why: `gap where the bridge was (dx ${gapAhead.toFixed(0)}) → jump` };
    return { intent: "advance_fire", why: `gap ahead (dx ${gapAhead.toFixed(0)}), lining up the jump` };
  }
  // 3. Sniper / turret above us: straight up when overhead, diagonal when it is ahead and above.
  const above = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  // Very close overhead, or a turret that cannot be one-shot (hp > 1): do not stand under it.
  if (above && (above.dy > -44 || above.hp > 1)) return { intent: "retreat", why: `hostile overhead (dx ${above.dx}, dy ${above.dy}, hp ${above.hp}) → step back` };
  if (above) return { intent: "aim_up_fire", why: `hostile above (dy ${above.dy})` };
  const diag = rel.find((e) => e.category === "hostile" && e.dx >= 24 && e.dx < 96 && e.dy < -r.aimUpHeight && e.dy > -100 && Math.abs(Math.abs(e.dx) - Math.abs(e.dy)) < 40);
  if (diag) return { intent: "aim_diag_fire", why: `hostile up-ahead (dx ${diag.dx}, dy ${diag.dy}) → diagonal` };
  return undefined;
}

/** Default plan when no model has a fresh opinion. */
export function heuristicIntent(game: GameProfile, obs: Observation, mem: PolicyMemory, now: number): { intent: Intent; why: string } {
  const r = game.reflex;
  const ai = obs.ai;
  const { sign } = fwdBack(obs);
  const rel = relative(obs, sign);
  const hostile = rel.filter((e) => e.category === "hostile");
  const items = rel.filter((e) => e.category === "item");

  // Weapon capsule flying past above: shoot it down. Weapon item on the ground nearby: go get it.
  const capsule = items.find((e) => e.type === 3 && Math.abs(e.dx) < 56 && e.dy < -16 && e.dy > -96);
  if (capsule) return { intent: "aim_up_fire", why: "shoot the weapon capsule" };
  const pickup = items.find((e) => e.type !== 3 && Math.abs(e.dx) < (r.itemDistance ?? 96) && Math.abs(e.dy) < 48 && hostile.every((h) => h.dist > 48));
  if (pickup) return { intent: pickup.dx >= 0 ? "advance_fire" : "retreat", why: `weapon item ${pickup.dx >= 0 ? "ahead" : "behind"} (dx ${pickup.dx})` };

  const ahead = hostile.find((e) => e.dx > 0 && e.dx < r.engageDistance && Math.abs(e.dy) < 24);
  if (ahead) return { intent: ahead.approaching || ahead.hp > 1 ? "hold_fire" : "advance_fire", why: `hostile ahead (dx ${ahead.dx}${ahead.approaching ? ", closing" : ""})` };
  const behind = hostile.find((e) => e.dx < 0 && e.dx > -r.engageDistance && Math.abs(e.dy) < 24 && e.approaching);
  if (behind) return { intent: "retreat", why: `hostile behind (dx ${behind.dx})` };

  if (obs.human.alive) {
    const dxP = (obs.human.x - ai.x) * sign;
    const dyP = obs.human.y - ai.y;
    if (obs.levelDirection === "up" && dyP < -40 && ai.onGround && now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: "partner is above, climb" };
    if (dxP < -r.followDistance) return { intent: "hold_fire", why: `ahead of partner by ${-dxP}px, covering` };
    if (dxP > r.followDistance * 2) return { intent: "follow_partner", why: `partner ${dxP}px ahead` };
  }
  // Stuck against something while trying to advance: hop.
  if (mem.stillSince && now - mem.stillSince > 1500 && ai.onGround && now - mem.lastJumpAt > 1200) return { intent: "jump_forward", why: "stuck, hopping" };
  return { intent: "advance_fire", why: "path clear" };
}

/** Buttons for an intent. */
export function actionFor(game: GameProfile, obs: Observation, intent: Intent, mem: PolicyMemory, now: number): Action {
  const fire = game.buttons.fire as Button;
  const jump = game.buttons.jump as Button;
  const prone = (game.buttons.prone ?? "DOWN") as Button;
  const up = (game.buttons.aimUp ?? "UP") as Button;
  const turbo = game.reflex.turboFire ? [fire] : [];
  const holdFire = game.reflex.turboFire ? [] : [fire];
  const { fwd, back, sign } = fwdBack(obs);
  const ai = obs.ai;

  // Track standing still for the stuck detector and the facing direction.
  if (ai.x === mem.lastX) mem.stillSince ||= now;
  else mem.stillSince = 0;
  mem.lastX = ai.x;
  if (ai.xVel !== 0) mem.facing = ai.xVel > 0 ? 1 : -1;
  const walk = (dir: Button): Button[] => {
    mem.facing = dir === "RIGHT" ? 1 : -1;
    return [dir];
  };
  /**
   * Shoot in a direction without walking into it: tap the direction just long enough to turn the
   * sprite (Contra keeps facing the last direction pressed), then fire standing still.
   */
  const partnerMovingForward = obs.human.alive && obs.human.xVel === sign;
  const face = (dir: 1 | -1, reason: string, tagBase: string): Action => {
    // A partner who keeps walking forward drags the screen (and explodes bridges behind them):
    // never stand still then, walk along instead.
    if (partnerMovingForward && dir === sign) return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: `${reason}, partner moving → keep up` };
    const key: Button = dir > 0 ? "RIGHT" : "LEFT";
    if (mem.facing !== dir && !mem.turnUntil) mem.turnUntil = now + 130;
    if (mem.turnUntil && now < mem.turnUntil) return { hold: [key, ...holdFire], turbo, tag: `${tagBase}:turn`, reason: `${reason} (turning)` };
    mem.turnUntil = 0;
    mem.facing = dir;
    return { hold: [...holdFire], turbo, tag: tagBase, reason };
  };

  switch (intent) {
    case "advance_fire": {
      const onHazard = relative(obs, sign).some((e) => e.category === "hazard" && Math.abs(e.dx) < 40 && e.dy > -8 && e.dy < 48);
      if (obs.human.alive && !ai.invincible && !onHazard) {
        const dxP = (obs.human.x - ai.x) * sign;
        if (dxP < -game.reflex.followDistance) return face(sign, "waiting for partner", "cover");
      }
      return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "advance" };
    }
    case "follow_partner": {
      if (!obs.human.alive) return { hold: [...walk(fwd), ...holdFire], turbo, tag: `${fwd}+${fire}`, reason: "no partner, advance" };
      const dx = obs.human.x - ai.x;
      if (Math.abs(dx) <= game.reflex.closeDistance) return face(sign, "next to partner", "cover");
      const dir: Button = dx > 0 ? "RIGHT" : "LEFT";
      return { hold: [...walk(dir), ...holdFire], turbo, tag: `${dir}+${fire}`, reason: "follow" };
    }
    case "hold_fire":
      return face(sign, "hold ground", fire);
    case "aim_up_fire":
      return { hold: [up, ...holdFire], turbo, tag: `${up}+${fire}`, reason: "aim up" };
    case "aim_diag_fire":
      // UP + forward fires diagonally; we drift forward a little, which is acceptable at 24+ px range.
      return { hold: [up, ...walk(fwd), ...holdFire], turbo, tag: `${up}+${fwd}+${fire}`, reason: "aim diagonal" };
    case "prone_fire":
      mem.proneSince ||= now;
      return { hold: [prone, ...holdFire], turbo, tag: `${prone}+${fire}`, reason: "prone" };
    case "jump_forward":
      mem.lastJumpAt = now;
      return { hold: [jump, ...walk(fwd), ...holdFire], turbo, tag: `${jump}+${fwd}`, reason: "jump forward" };
    case "jump_back":
      mem.lastJumpAt = now;
      return { hold: [jump, ...walk(back), ...holdFire], turbo, tag: `${jump}+${back}`, reason: "jump back" };
    case "retreat": {
      // Something is behind us: face it and shoot; only actually walk back when it is not adjacent.
      const rel = relative(obs, sign);
      const behind = rel.find((e) => e.category === "hostile" && e.dx < 0 && Math.abs(e.dy) < 24);
      if (behind && Math.abs(behind.dx) < 48) return face((-sign) as 1 | -1, "shoot behind", `${back}:${fire}`);
      return { hold: [...walk(back), ...holdFire], turbo, tag: `${back}+${fire}`, reason: "retreat" };
    }
    default:
      return IDLE;
  }
}

export function sameAction(a: Action, b: Action): boolean {
  return a.hold.join() === b.hold.join() && a.turbo.join() === b.turbo.join();
}
