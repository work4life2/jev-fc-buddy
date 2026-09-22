import type { GameProfile } from "../games/registry.js";
import type { Observation } from "./observe.js";
import { JEV_ACTIONS, type JevAction } from "./jev.js";
import { canRetreat, edgeAhead, gapAhead, isShooter, jumpIsSafe, lagging, relative, threatOf, type PolicyMemory } from "./policy.js";

/**
 * Jev chooses among actions whose descriptions are computed for the current state: what each move
 * does *right now* (walks into a shooter's reach, jumps into a bullet, steps off a ledge, leaves the
 * partner) rather than a fixed sentence. Code computes the facts; Jev makes the judgement.
 */
export function actionCriteria(game: GameProfile, obs: Observation, mem: PolicyMemory): Record<keyof typeof JEV_ACTIONS, string> {
  const sign: 1 | -1 = 1;
  const ai = obs.ai;
  const rel = relative(obs, sign);
  const hostile = rel.filter((e) => e.category === "hostile");
  const bullets = rel.filter((e) => e.category === "projectile");
  const nearBullets = bullets.filter((e) => Math.abs(e.dx) + Math.abs(e.dy) < 96 && (e.approaching || Math.abs(e.dx) < 32));
  const threats = bullets.map((e) => threatOf(e, game.reflex.dodgeDistance ?? 80)).filter((t) => t !== undefined);
  threats.sort((a, b) => a!.ticks - b!.ticks);
  const first = threats[0];
  const shooters = hostile.filter((e) => Math.abs(e.dy) > 28 && Math.abs(e.dy) < 130 && Math.abs(e.dx) < 120 && isShooter(game, e));
  const shooterAhead = shooters.find((e) => e.dx > 0);
  const shooterBehind = shooters.find((e) => e.dx <= 0);
  const runnerAhead = hostile.find((e) => e.dx > 0 && e.dx < 64 && Math.abs(e.dy) < 24);
  const runnerBehind = hostile.find((e) => e.dx <= 0 && e.dx > -64 && Math.abs(e.dy) < 24);
  const above = hostile.find((e) => Math.abs(e.dx) < 24 && e.dy < -20 && e.dy > -90);
  const edge = edgeAhead(game, obs, sign);
  const gap = gapAhead(game, obs, mem, sign, 80);
  const retreatOk = canRetreat(game, obs, mem, sign);
  const partner = obs.human.alive ? (obs.human.x - ai.x) * sign : undefined;
  const lag = lagging(game, obs, sign);
  const px = (n: number) => `${Math.round(n)}px`;
  const air = nearBullets.length ? `${nearBullets.length} bullet(s) in the air nearby: a jump cannot be steered out of them` : "the air nearby is clear";

  const note = (base: string, facts: string[]): string => `${base} Now: ${facts.filter(Boolean).join("; ")}.`;
  const forwardFacts: string[] = [];
  if (edge && !edge.dropOk && edge.dist <= 40) forwardFacts.push(edge.landing ? `the platform ends in ${px(edge.dist)}, a jump from the edge reaches the next one (dy ${edge.landing.dy})` : `the platform ends in ${px(edge.dist)} with NOTHING to land on: walking on means falling to death`);
  if (gap && gap.dxStart < 60 && gap.kind !== "bridge") forwardFacts.push(`a ${gap.kind === "hop" ? "narrow drop to jump" : "deadly pit"} starts in ${px(gap.dxStart)}`);
  if (runnerAhead) forwardFacts.push(`a hostile ${px(runnerAhead.dx)} ahead at our height${runnerAhead.approaching ? ", coming at us" : ""}: walking with turbo fire kills it unless it is already touching`);
  if (shooterAhead) forwardFacts.push(`a shooter ${px(shooterAhead.dx)} ahead, ${shooterAhead.dy > 0 ? "below" : "above"} us: moving keeps its aimed shots missing, standing does not`);
  if (partner !== undefined && partner < -game.reflex.followDistance) forwardFacts.push(`the partner is ${px(-partner)} behind: this leaves them`);
  if (lag) forwardFacts.push(`the partner is ${px(partner!)} ahead and the screen cannot scroll until we catch up`);

  return {
    advance_fire: note(JEV_ACTIONS.advance_fire, forwardFacts.length ? forwardFacts : ["the path ahead is clear"]),
    follow_partner: note(JEV_ACTIONS.follow_partner, partner === undefined ? ["no living partner: same as advancing"] : [`the partner is ${px(Math.abs(partner))} ${partner >= 0 ? "ahead" : "behind"}, ${px(obs.human.y - ai.y)} ${obs.human.y - ai.y <= 0 ? "above" : "below"}`, partner < 0 && !retreatOk ? "going back is blocked (screen edge or a drop behind)" : ""]),
    hold_fire: note(JEV_ACTIONS.hold_fire, [
      shooters.length ? `a shooter on another height is in range (dx ${px(shooters[0]!.dx)}, dy ${px(shooters[0]!.dy)}): standing still is exactly where its aimed shots land` : "no shooter on another height in range",
      runnerAhead ? `the hostile ${px(runnerAhead.dx)} ahead dies to our fire before it arrives` : "",
      runnerBehind ? `a hostile ${px(-runnerBehind.dx)} BEHIND us would not be hit` : "",
      first ? `the nearest bullet reaches us in ${first!.ticks.toFixed(0)} ticks and standing does not avoid it` : "",
    ]),
    aim_up_fire: note(JEV_ACTIONS.aim_up_fire, [above ? `a hostile is ${px(-above.dy)} straight above (dx ${px(above.dx)})` : "nothing is straight above us: this only wastes time"]),
    jump_forward: note(JEV_ACTIONS.jump_forward, [
      air,
      first && first!.kind === "low" ? `the nearest bullet is level at foot height (${first!.ticks.toFixed(0)} ticks): a jump clears it` : "",
      first && first!.kind !== "low" ? `the nearest bullet is ${first!.kind === "body" ? "at body height: a jump lifts us into it" : "rising/diving: a jump does not leave its line"}` : "",
      edge && edge.landing ? `from the ledge in ${px(edge.dist)} it lands on the next platform` : "",
      edge && !edge.dropOk && !edge.landing && edge.dist <= 40 ? "there is no platform to land on beyond this ledge" : "",
      gap && gap.kind === "hop" && gap.dxStart < 40 ? `it clears the ${px(gap.width)} drop if taken within ${px(Math.max(0, gap.dxStart))}` : "",
    ]),
    jump_back: note(JEV_ACTIONS.jump_back, [air, retreatOk ? "there is room behind" : "no room behind (screen edge or drop): this becomes a jump forward", runnerAhead && runnerAhead.dx < 24 ? `the hostile ${px(runnerAhead.dx)} ahead is about to touch` : ""]),
    retreat: note(JEV_ACTIONS.retreat, [
      retreatOk ? "there is room behind" : "BLOCKED: screen edge or a drop behind, the buddy would only stand",
      shooterBehind ? `a shooter is ${px(-shooterBehind.dx)} behind/${shooterBehind.dy > 0 ? "below" : "above"}: backing off puts us straight over/under it` : "",
      runnerBehind ? `a hostile ${px(-runnerBehind.dx)} behind: we would turn and shoot it` : "",
      partner !== undefined && partner > game.reflex.followDistance ? `the partner is ${px(partner)} ahead: this drifts away from them` : "",
    ]),
    prone_fire: note(JEV_ACTIONS.prone_fire, [
      first ? (first!.kind === "body" ? `the nearest bullet flies level at body height (${first!.ticks.toFixed(0)} ticks): it passes over a prone body` : first!.kind === "low" ? "the nearest bullet is at foot height: it hits a prone body" : "the nearest bullet is rising/diving: it hits a prone body") : "no bullet is coming: lying down only slows us",
      shooters.length ? "prone is still a standing target for aimed shots from another height" : "",
    ]),
  };
}
