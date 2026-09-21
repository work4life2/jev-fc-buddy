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
  /** A positional evasion (leave a shooter, sidestep a fan) is kept for a while so rules do not thrash. */
  commit?: { intent: Intent; why: string; until: number };
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

export interface GapInfo {
  /** Distance (level-forward px) from the buddy to the gap's near edge (negative = inside/past). */
  dxStart: number;
  dxEnd: number;
  width: number;
  inside: boolean;
  partner: "behind" | "near" | "on" | "beyond" | "none";
  /** bridge = crossable while it explodes; pit = never passable at this height. */
  kind: "bridge" | "pit" | "hop";
}

/** The nearest known pit ahead (profile terrain + hazards remembered this level), if within `range`. */
export function gapAhead(game: GameProfile, obs: Observation, mem: PolicyMemory, sign: 1 | -1, range = 200): GapInfo | undefined {
  const zones: Array<[number, number, GapInfo["kind"]]> = (game.terrain?.gaps?.[String(obs.level)] ?? [])
    .filter((z) => z.length < 4 || (obs.ai.y >= (z[2] as number) && obs.ai.y <= (z[3] as number)))
    .map((z) => [z[0], z[1], (z[4] as GapInfo["kind"] | undefined) ?? "bridge"] as [number, number, GapInfo["kind"]]);
  for (const g of mem.gaps) if (!zones.some(([a, b]) => g >= a - 24 && g <= b + 24)) zones.push([g - 16, g + 16, "bridge"]);
  const me = obs.ai.levelX;
  let best: GapInfo | undefined;
  for (const [a, b, kind] of zones) {
    const start = sign > 0 ? a : b;
    const end = sign > 0 ? b : a;
    const dxStart = (start - me) * sign;
    const dxEnd = (end - me) * sign;
    if (dxEnd < -8 || dxStart > range) continue;
    const inside = dxStart <= 8 && dxEnd >= -8;
    let partner: GapInfo["partner"] = "none";
    if (obs.human.alive) {
      const p = (obs.human.levelX - me) * sign;
      partner = p > dxEnd + 8 ? "beyond" : p >= dxStart - 8 ? "on" : p > dxStart - 72 ? "near" : "behind";
    }
    const info = { dxStart, dxEnd, width: Math.abs(b - a), inside, partner, kind };
    if (!best || info.dxStart < best.dxStart) best = info;
  }
  return best;
}

/** During the respawn fall the buddy can steer: aim for solid ground next to the partner. */
export function respawnSteer(game: GameProfile, obs: Observation, mem: PolicyMemory): { dir: Button; why: string } | undefined {
  if (obs.ai.state !== game.playerState.falling) return undefined;
  const zones = game.terrain?.gaps?.[String(obs.level)] ?? [];
  const me = obs.ai.levelX;
  const zone = zones.map((z) => [z[0], z[1]] as [number, number]).find(([a, b]) => me >= a - 12 && me <= b + 12);
  if (zone) {
    // Over a pit: drift to whichever edge is closer to the partner (or simply the nearer edge).
    const target = obs.human.alive ? (obs.human.levelX >= (zone[0] + zone[1]) / 2 ? zone[1] + 20 : zone[0] - 20) : me - zone[0] < zone[1] - me ? zone[0] - 20 : zone[1] + 20;
    return { dir: target > me ? "RIGHT" : "LEFT", why: `respawning over a pit → drift to ${target > me ? "right" : "left"} edge` };
  }
  if (obs.human.alive && Math.abs(obs.human.levelX - me) > 24) return { dir: obs.human.levelX > me ? "RIGHT" : "LEFT", why: "respawning → drift toward partner" };
  return undefined;
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
  // 1a. A shooter directly below us (pill box under a ledge fires straight up): never linger above it.
  if (mem.commit && now < mem.commit.until) return { intent: mem.commit.intent, why: mem.commit.why };
  mem.commit = undefined;
  const under = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 40 && e.dy > 28 && e.dy < 110);
  if (under) {
    // Leave toward the partner's side (forward by default); backing off only when it is clearly ahead.
    const partnerSide: 1 | -1 = obs.human.alive ? ((obs.human.x - ai.x) * sign >= 0 ? 1 : -1) : 1;
    const dir: 1 | -1 = under.dx > 24 && partnerSide < 0 ? -1 : under.dx > 24 && ai.x * sign > 48 ? -1 : 1;
    mem.commit = { intent: dir === sign ? "advance_fire" : "retreat", why: `shooter below (dx ${under.dx}, dy ${under.dy}) → move off it`, until: now + 600 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  let low: Rel | undefined; // a bullet that will arrive below the waist: jump it
  let body: Rel | undefined; // a bullet at body/head height: lie under it
  let steep: Rel | undefined; // a bullet coming down (or up) almost vertically: sidestep it
  for (const e of rel) {
    if (e.category !== "projectile") continue;
    const passing = Math.abs(e.dx) < 28; // already next to us: stay down until it is gone
    if (Math.abs(e.dx) > dodge || (!e.approaching && !passing)) continue;
    const vertical = e.vx === 0 && rel.some((h) => h.category === "hostile" && Math.abs(h.dx - e.dx) < 12 && h.dy > e.dy + 10);
    if (vertical) {
      steep ??= { ...e, vy: -3 };
      continue;
    }
    const atBodyNow = Math.abs(e.dx) < 20 && e.dy > -30 && e.dy < 22; // already on us: only prone can help
    if (!atBodyNow && Math.abs(e.vy) >= 2 && Math.abs(e.vy) >= Math.abs(e.vx) && Math.abs(e.dx) < 32 && ((e.vy > 0 && e.dy < 0 && e.dy > -70) || (e.vy < 0 && e.dy > 0 && e.dy < 70))) {
      steep ??= e;
      continue;
    }
    // Where will it be (vertically) when it reaches us? Diagonal shots from snipers above start high.
    const ticks = Math.abs(e.dx) / Math.max(Math.abs(e.vx), 3); // a bullet next to us arrives now, whatever vx says
    const yAt = e.dy + e.vy * Math.min(ticks, 12);
    if (yAt < -30 || yAt > 22) continue; // will pass over the head or under the feet
    if (yAt > 10 && Math.abs(e.dx) > 12) low ??= { ...e, dy: yAt };
    else body ??= { ...e, dy: yAt };
  }
  if (steep && !body) {
    const held = mem.commit as PolicyMemory["commit"];
    if (held && now < held.until) return { intent: held.intent, why: held.why };
    // A fan of diagonal shots from a turret: run away from the shooter when we know where it is,
    // else with the bullet's horizontal drift — and keep that direction for a while (no thrashing).
    const shooter = rel.find((e) => e.category === "hostile" && Math.abs(e.dx - steep!.dx) < 48 && Math.abs(e.dy) > 24);
    const drift: 1 | -1 = shooter ? (shooter.dx > 0 ? -1 : 1) : steep.vx !== 0 ? (steep.vx > 0 ? 1 : -1) : steep.dx > 0 ? -1 : 1;
    const c = { intent: (drift === sign ? "advance_fire" : "retreat") as Intent, why: `steep shot (dx ${steep.dx}, dy ${steep.dy}, vy ${steep.vy}) → run ${drift > 0 ? "right" : "left"}`, until: now + 500 };
    mem.commit = c;
    return { intent: c.intent, why: c.why };
  }
  if (low || body) {
    if (!ai.onGround) return undefined; // mid-air: nothing to be done
    // With anything at body height prone wins (a jump would lift us into it); otherwise hop the low one.
    if (body) return { intent: "prone_fire", why: `bullet incoming (dx ${body.dx}, y@ ${body.dy.toFixed(0)})` };
    if (Math.abs(low!.dx) >= 26 && now - mem.lastJumpAt > 700) return { intent: "jump_forward", why: `low shot (dx ${low!.dx}, y@ ${low!.dy.toFixed(0)}) → jump` };
    return { intent: low!.dx > 0 ? "retreat" : "advance_fire", why: `low shot too close to jump (dx ${low!.dx}) → back off` };
  }
  // 1b. A hostile dropping onto us from a ledge above (soldiers jump down): step back out from under it.
  const diver = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 28 && e.dy < -12 && e.dy > -56 && e.vy > 0);
  if (diver && Math.abs(diver.dx) < 12 && diver.hp <= 1) return { intent: "aim_up_fire", why: `hostile dropping onto us (dx ${diver.dx}, dy ${diver.dy}) → shoot up` };
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
  // 2b. Pits (bridges that explode once crossed). Inside: never stop. Ahead: cross together with the
  //     partner; if the partner is already far beyond, the bridge is gone — do not walk in.
  const gap = gapAhead(game, obs, mem, sign);
  if (gap && gap.kind === "hop") {
    // A narrow drop: run at it and jump from the edge; never stop on the edge.
    if (gap.inside && !ai.onGround) return undefined;
    if (gap.dxStart <= 30 && gap.dxStart > -4 && ai.onGround && now - mem.lastJumpAt > 800) return { intent: "jump_forward", why: `drop ahead (dx ${gap.dxStart.toFixed(0)}, ${gap.width}px) → jump` };
    if (gap.dxStart <= 60) return { intent: "advance_fire", why: `drop in ${gap.dxStart.toFixed(0)}px → run up to it` };
  } else if (gap && gap.kind === "pit") {
    // Dead end at this height: never walk in; get up to the partner's ledge instead.
    if (gap.dxStart < 40) {
      if (obs.human.alive && obs.human.y < ai.y - 40 && ai.onGround && now - mem.lastJumpAt > 900) return { intent: "jump_forward", why: `pit ahead (dx ${gap.dxStart.toFixed(0)}), partner above → try to climb` };
      return { intent: "hold_fire", why: `pit ahead (dx ${gap.dxStart.toFixed(0)}) → stop, this route ends here` };
    }
  } else if (gap) {
    if (gap.inside) return { intent: "advance_fire", why: `on the bridge (${gap.dxEnd.toFixed(0)}px to go) → keep moving` };
    if (gap.dxStart < 24) {
      if (gap.partner === "beyond" && !rel.some((e) => e.category === "hazard")) return { intent: "hold_fire", why: `pit ahead (${gap.width}px), bridge gone → wait at the edge` };
      if (gap.partner === "on" || gap.partner === "near" || rel.some((e) => e.category === "hazard")) return { intent: "advance_fire", why: `bridge edge, partner ${gap.partner} → cross now` };
      return { intent: "hold_fire", why: `bridge edge, partner ${gap.partner} → wait, cross together` };
    }
    if (gap.partner === "on" || (gap.partner === "near" && obs.human.xVel === sign)) return { intent: "advance_fire", why: `bridge in ${gap.dxStart.toFixed(0)}px, partner crossing → sprint` };
  }
  // 2c. Something that cannot be one-shot (turret, wall sensor, hp > 1) close by: keep 56+ px away.
  const keep = (e: Rel): number => {
    const byType = game.enemyTypes?.keepDistance?.[`0x${e.type.toString(16).padStart(2, "0")}`];
    if (typeof byType === "number") return byType;
    return e.hp > 1 ? 72 : 0;
  };
  const heavy = rel.find((e) => e.category === "hostile" && keep(e) > 0 && Math.abs(e.dx) < keep(e) && e.dy > -100 && e.dy < 24);
  if (heavy) {
    mem.commit = { intent: heavy.dx >= 0 ? "retreat" : "advance_fire", why: `stationary shooter #${heavy.type.toString(16)} at dx ${heavy.dx}, dy ${heavy.dy} → keep ${keep(heavy)}px`, until: now + 500 };
    return { intent: mem.commit.intent, why: mem.commit.why };
  }
  // 3. Sniper / turret above us: straight up when overhead, diagonal when it is ahead and above.
  const above = rel.find((e) => e.category === "hostile" && Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  // Very close overhead, or a turret that cannot be one-shot (hp > 1): do not stand under it.
  if (above && above.dy > -44) return { intent: "retreat", why: `hostile right overhead (dx ${above.dx}, dy ${above.dy}) → step back` };
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

  const above = hostile.find((e) => Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  if (above && above.hp > 1) return { intent: "retreat", why: `turret overhead (hp ${above.hp}) → step back` };
  if (above) return { intent: "aim_up_fire", why: `hostile above (dy ${above.dy})` };
  const diag = hostile.find((e) => e.dx >= 24 && e.dx < 96 && e.dy < -r.aimUpHeight && e.dy > -100 && Math.abs(Math.abs(e.dx) - Math.abs(e.dy)) < 40);
  if (diag) return { intent: "aim_diag_fire", why: `hostile up-ahead (dx ${diag.dx}, dy ${diag.dy}) → diagonal` };
  const ahead = hostile.find((e) => e.dx > 0 && e.dx < r.engageDistance && Math.abs(e.dy) < 24);
  if (ahead) return { intent: ahead.approaching || ahead.hp > 1 ? "hold_fire" : "advance_fire", why: `hostile ahead (dx ${ahead.dx}${ahead.approaching ? ", closing" : ""})` };
  const behind = hostile.find((e) => e.dx < 0 && e.dx > -r.engageDistance && Math.abs(e.dy) < 24 && e.approaching);
  if (behind) return { intent: "retreat", why: `hostile behind (dx ${behind.dx})` };

  if (obs.human.alive) {
    const dxP = (obs.human.x - ai.x) * sign;
    const dyP = obs.human.y - ai.y;
    if (dyP < -40 && Math.abs(dxP) < 96 && ai.onGround && now - mem.lastJumpAt > 900) return { intent: "jump_forward", why: `partner is ${-dyP}px above → try to climb` };
    if (dxP < -r.followDistance) return { intent: "hold_fire", why: `ahead of partner by ${-dxP}px, covering` };
    if (dxP > r.followDistance * 2) return { intent: "follow_partner", why: `partner ${dxP}px ahead` };
  }
  // Stuck against something while trying to advance: hop.
  if (mem.stillSince && now - mem.stillSince > 1500 && ai.onGround && now - mem.lastJumpAt > 1200) return { intent: "jump_forward", why: "stuck, hopping" };
  return { intent: "advance_fire", why: "path clear" };
}

/** Buttons for an intent. */
export function actionFor(game: GameProfile, obs: Observation, intent: Intent, mem: PolicyMemory, now: number): Action {
  // At the trailing screen edge the shared screen cannot scroll: backing off further only jams the
  // game for both players, so turn a retreat into standing fire / a jump-back into a jump-forward.
  const edgeSign = obs.levelDirection === "up" && obs.human.alive ? (obs.human.x >= obs.ai.x ? 1 : -1) : 1;
  const atTrailingEdge = edgeSign > 0 ? obs.ai.x < 28 : obs.ai.x > obs.screen.width - 28;
  if (atTrailingEdge && intent === "retreat") {
    const upAhead = relative(obs, edgeSign as 1 | -1).find((e) => e.category === "hostile" && e.dx > 0 && e.dx < 110 && e.dy < -24 && e.dy > -100);
    intent = upAhead ? "aim_diag_fire" : "hold_fire";
  }
  if (atTrailingEdge && intent === "jump_back") intent = "jump_forward";
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
