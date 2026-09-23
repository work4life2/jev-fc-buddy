import type { GameProfile } from "../games/registry.js";
import { GameController } from "./control.js";
import { observe, type Observation } from "./observe.js";
import type { PolicyMemory } from "./policy.js";
import type { Tactic } from "./tactics.js";

export interface Forecast {
  id: string;
  died: boolean;
  partnerDied: boolean;
  progress: number;
  separation: number;
  scenarios: number;
}

export interface RolloutInput {
  snapshot: unknown;
  controllers: number[][];
  game: GameProfile;
  observation: Observation;
  memory: PolicyMemory;
  candidates: Tactic[];
  frame: number;
}

export interface Simulation {
  cpu: { mem: number[] };
  controllers: Record<number, { state: number[] }>;
  fromJSON(state: unknown): void;
  buttonDown(c: number, b: number): void;
  buttonUp(c: number, b: number): void;
  frame(): void;
}

const BUTTONS = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];

/** Advisory forecasts: a separate emulator, two plausible human continuations, bounded horizon. */
export function forecastPlans(nes: Simulation, input: RolloutInput, frames = 45): Forecast[] {
  const rows: Forecast[] = [];
  for (const candidate of input.candidates.slice(0, 6)) {
    const results: Forecast[] = [];
    for (const humanMode of ["continue", "release"] as const) {
      // jsnes restores array references, so every branch needs its OWN snapshot copy.
      nes.fromJSON(structuredClone(input.snapshot));
      for (const c of [1, 2]) nes.controllers[c]!.state = [...input.controllers[c - 1]!];
      const controller = new GameController(input.game);
      controller.mem = structuredClone(input.memory);
      controller.candidates = input.candidates;
      controller.accept({ tactic: candidate, frame: input.frame, ttlMs: 1500, probability: 1 }, input.observation, input.frame);
      let previous = input.observation;
      let action = controller.step(previous).action;
      let died = false, partnerDied = false;
      let nextTick = 2.5;
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < 8; b++) {
          const down = action.hold.includes(BUTTONS[b] as never) || (action.turbo.includes(BUTTONS[b] as never) && (((input.frame + f) >> 2) & 1) === 1);
          if (down) nes.buttonDown(input.game.players.ai, b); else nes.buttonUp(input.game.players.ai, b);
          if (humanMode === "release" && b !== 1) nes.buttonUp(input.game.players.human, b);
        }
        nes.frame();
        if (f + 1 >= nextTick || f === frames - 1) {
          nextTick += 2.5;
          const bytes = new Uint8Array(input.game.ramRanges.reduce((n, [a, b]) => n + b - a, 0));
          let off = 0;
          for (const [a, b] of input.game.ramRanges) { bytes.set(nes.cpu.mem.slice(a, b), off); off += b - a; }
          const obs = observe(input.game, bytes, previous);
          obs.at = input.observation.at + (f + 1) * 1000 / 60;
          died ||= previous.ai.alive && !obs.ai.alive && obs.phase === "playing";
          partnerDied ||= previous.human.alive && !obs.human.alive && obs.phase === "playing";
          action = controller.step(obs, obs.at).action;
          previous = obs;
        }
      }
      results.push({ id: candidate.id, died, partnerDied, progress: previous.level === input.observation.level ? previous.ai.levelX - input.observation.ai.levelX : previous.level > input.observation.level ? 256 : 0, separation: Math.abs(previous.ai.x - previous.human.x), scenarios: 1 });
    }
    rows.push({ id: candidate.id, died: results.some(r => r.died), partnerDied: results.some(r => r.partnerDied), progress: Math.min(...results.map(r => r.progress)), separation: Math.max(...results.map(r => r.separation)), scenarios: results.length });
  }
  return rows;
}
