# Decision quality investigation: Contra

Date: 2026-09-23. Local and production HEAD: `a5c466d`.

## Conclusion

Jev is called in production and sometimes changes the executed policy. There is
no adequate evidence yet that enabling it improves the co-op experience. Several
integration defects independently prevent good model judgments from producing
good gameplay. The best architecture for demonstrating Jev is a tactical planner
over executable, simulated candidate plans, with a local frame-level controller.
Jev's contribution must be measured against the identical controller without Jev.

This investigation changes no production code, prompts, configuration, or service.
Diagnostic artifacts are under `data/train/`; this report is the only tracked edit.

## Evidence and limits

- Read production journal entries covering the preceding 24 hours over SSH.
  No production service or configuration was changed.
- Latest observed session ended at 2026-09-23 00:44:08 UTC: 265 play seconds,
  745 Jev request attempts, 1,977,867 input / 116,815 output tokens, 16 buddy
  deaths and 8 human deaths. Calls and token consumption demonstrate successful
  inference, not beneficial decisions.
- Production also logged a cluster of 2500 ms request timeouts on September 22.
  The excerpt is not sufficient to estimate an overall failure rate.
- Production deaths around level-x 2300-2840 repeatedly involve falling, waiting
  at pits, or respawning over pits. Some older entries label RIGHT+B with a reason
  saying to stop. Journal history spans earlier revisions as well as current HEAD.
- Latest session includes `Jev advance_fire over plan [corridor: firing at the
  target ...]` immediately before two deaths. This confirms overrides, but does
  not prove the counterfactual outcome had the original plan been retained.
- Before the new Jev smoke run, local reports numbered 891: 889 recorded Jev off
  and only 2 recorded it on. That count includes this investigation's first
  reflex-only smoke run. The learned map reports 866 episodes; those episodes
  update terrain knowledge, not model weights.

### Fixed-seed smoke comparison

Commands, executed locally using the same game profile and compiled brain:

```sh
node dist/index.js train run --episodes 1 --seed 7000 --frames 3600
node dist/index.js train run --episodes 1 --seed 7000 --frames 3600 --jev -v
```

| Mode | Furthest level-x | Deaths | Reported wall time |
| --- | ---: | ---: | ---: |
| Reflex only | 1980 | 1 | 6.1 s |
| Jev enabled | 1751 | 0 | 46.5 s |

The budget includes menu frames; this is not a full 60-second gameplay episode.
Jev mode is paced to wall time; reflex mode uses virtual time. There is no browser
network round trip in either local run. Model latency is nondeterministic.
One solo episode cannot establish positive or negative co-op impact.

The verbose Jev log has 18 action-change response samples, with latency
min/median/max 686/769/1638 ms, 6 logged overrides of plans, and no request failures.
These are selectively logged samples, not the distribution of all requests or
the fraction of frames controlled by Jev.

### Deterministic contract probes

```sh
node data/train/diagnostic-contracts.mjs
```

This diagnostic exits nonzero on current behavior. All three checks fail:

1. `actionFor(..., 'hold_fire', ...)` emits RIGHT when a living partner moves
   forward. Tested against the actual executor, not a duplicated implementation.
2. `jevState` describes a 32 px `kind: hop` as an exploding bridge too wide to jump.
3. Injecting a response requested 2000 ms ago but received now into the actual
   brain causes a Jev-sourced LEFT action. The requested action horizon is 500 ms.

These focused probes demonstrate specific defects. They do not quantify how much
each defect contributes to aggregate deaths.

## Findings

1. **Execution changes the meaning of a plan.** `src/ai/policy.ts:808` changes
   facing/holding into forward walking when the partner moves. This affects
   hold_fire and several other intents. `src/ai/player.ts:330` then overwrites the
   action reason with the upstream reason, potentially hiding the change.
   The safety decision must survive through final button generation.

2. **Freshness is measured from receipt, not observation.**
   `src/ai/player.ts:250` records arrival time and line 268 uses that for a 1200 ms
   freshness window. `askedAt` only orders responses. With the observed 769 ms
   median among logged responses, a decision can be used when its source state
   is almost two seconds old. Successful calls near the 2500 ms timeout can
   theoretically extend this toward 3.7 seconds. There is no life/stage epoch
   invalidation for pending responses. Browser transport adds further delay.

3. **Input facts and instructions disagree.** `src/ai/jev.ts:121` discards the
   gap kind and labels every gap an unjumpable exploding bridge. Line 135 says
   velocity is per roughly 1/12 second, but default observations are 24 Hz;
   the run-and-gun observer uses raw relative deltas without frame normalization.
   `onGround` derives from a jump flag that can be clear during a fall. The brain
   has additional fall detection, but the serialized model state does not.

4. **Stage semantics and candidate coverage are inconsistent.** The same eight
   action descriptions are used for side-scrolling and corridor stages.
   `aim_up_fire` means entering an opened corridor in one rule, but its dynamic
   description says it wastes time when no enemy is directly overhead. The
   executor supports jump_up, diagonal fire and backward fire, but Jev cannot
   select those actions. The prompt tells it to agree with a rule proposal even
   when that proposal names an unavailable action. Nearby-projectile rules both
   recommend a low-shot jump and forbid jumping near any projectile.

5. **There is no stable tactical decision contract.** Jev picks a short button
   intent from a snapshot; there is no target ID, goal completion condition,
   plan precondition or multi-step commitment. Independent Noul outputs can
   override the Choice result. A positioning commit may be returned without
   `plan: true` on later ticks, changing its override eligibility. This encourages
   oscillation and blurs model authority. Route context supplied to Jev also
   omits the brain's failed-hop exclusion set.

6. **Evaluation does not establish model value.** Default training disables Jev.
   The ledger omits model version, Jev mode, ROM/map hashes, latency and level
   completion. It summarizes level-local x as progress, so a newly entered level
   can appear worse than the end of the previous one. Its accepted reference is
   selected by death-rate score even though acceptance prefers reach, and it
   compares against one reference rather than every earlier candidate. A 30-life
   ROM plus a progress-first score can accept a more suicidal policy. The latest
   ledger entry has 213 deaths in each 12-episode group while being accepted for
   greater reach. Acceptance is advisory and does not prevent deployment.

7. **Attribution is incomplete.** `apply` suppresses updates when buttons match,
   even if decision source changes. Model proposal logs are only emitted on
   action changes. Existing logs cannot yield the percentage of decisions
   executed, overridden, expired, or causally useful.

## Recommended architecture

```text
Browser emulator and frame clock
  -> validated world state and recent human inputs
  -> candidate generator + short emulator rollouts in isolated workers
  -> semantic candidate summaries
  -> server-side Jev tactical selection
  -> versioned plan with target, preconditions and completion conditions
  -> local frame-level skill executor + hard safety constraints
  -> actual outcome and attribution trace
```

- Keep 60 Hz control and emergency avoidance beside the emulator. Model keys
  stay on the server. Expensive lookahead runs in workers, never on the render
  thread. Measure whether it fits the target device and move heavier search to
  dedicated compute if required.
- Separate grounded, ascending, descending, falling and respawning states.
  Normalize velocities to frames and retain observation frame, life epoch,
  stage/room epoch and tracked object identities. Verify RAM meanings using
  emulator trajectories and full save states, not plausible field names.
- Implement reliable skills: land on a selected platform, cross a bridge
  together, cover the partner from a selected position, collect a selected item,
  align with and destroy a corridor target, and fight a wall from a safe firing
  point. Express them through game-profile data and generic execution code.
- Generate several feasible plans. Short rollouts estimate collisions, landing,
  damage opportunities, progress and separation. Clone complete emulator state
  (CPU, PPU, mapper, RAM and controller state), not just the reported RAM bytes.
  Human future input is uncertain: simulate multiple plausible continuations
  from recent input and replan as new input arrives.
- Jev chooses among these plans using semantic tradeoffs: help a vulnerable
  partner, secure a useful weapon, wait for coordinated crossing, or advance via
  a safer route. Code computes physics and numeric comparisons. Jev receives
  compact consequences, not a request to mentally simulate projectile geometry.
- Start with a 1-3 second tactical horizon, event-triggered replanning and a
  modest periodic refresh. Tune using measured latency and plan lifetime.
  Emergency actions never wait for a model response. Reject responses whose
  life/stage epoch or plan preconditions no longer match, even if recently received.
- Candidate safety checks may reject unsafe choices; they must not silently
  transform one tactical plan into another. Record proposal, selection, safety
  rejection, fallback and final buttons separately.
- A stronger reasoning model can help offline with scenario discovery and
  candidate design. Keep the measured online tactical selector as Jev when
  claiming a Jev demonstration. Any runtime fallback to another model must be
  separately attributed and evaluated.

## Validation and delivery order

1. Fix executor contracts, freshness/epoch checks, fall state, gap semantics and
   stage-specific action coverage. Add full decision traces and full-state
   snapshots before failures. Run the required 24-episode policy evaluation if
   policy or criteria changes, while repairing its scoring limitations.
2. Build reliable movement and shooting skills, validate a complete first-stage
   route and corridor encounter, then introduce lookahead. Avoid claiming broad
   competence from one mapped stage.
3. Put Jev in charge of tactical choices and calibrate acceptance thresholds on
   held-out scenarios. Choice concentration is not the probability of surviving.
4. Compare identical executor, candidates, maps and safety layer with (a) fixed
   heuristic selection, (b) Jev selection, and (c) shuffled or random selection
   among safe candidates. An oracle may serve as an offline upper bound.
5. Use at least 24 paired full episodes for an initial gate, multiple live-model
   repetitions, and larger held-out scenario sets for a credible conclusion.
   Include scripted and recorded human styles: aggressive, cautious, waiting,
   retreating and jumping onto another route. Add human co-op sessions afterward.
6. Primary metrics: stage completion, team deaths, partner deaths, completion
   time, stuck duration and repeated respawn loops. Also record plan completion,
   override rate, expired-response rate, frame-based model authority and latency
   percentiles. Use paired differences and uncertainty intervals; do not infer
   improvement from token usage or a single win.
7. Show the user the chosen goal, alternatives and observed outcome. Label any
   explanation as a code-rendered summary of selected criteria; Jev does not
   generate a chain-of-thought explanation. Demonstrate paired replay branches
   at the same tactical fork to make actual model contribution visible.

The architecture creates a fair opportunity for Jev to help. It cannot guarantee
Jev outperforms a tuned deterministic selector; the controlled comparisons decide
whether and where its decision capability adds value.

## Outcome of the first implementation round (2026-09-23)

Steps 1–3 of the delivery order were implemented in one uncommitted working tree
(`src/ai/control.ts`, `tactics.ts`, `rollout.ts`, `trace.ts`, a `tests/` suite of
15 regression tests, browser-local control in `web/app.js` + `lookahead-worker.js`,
the v2 ledger protocol and `train compare`). Two evaluations closed the round.

### Reflex-only regression gate (`train eval`, 12 solo + 12 duo, seeds 7000..7011, 14400 frames)

| | v2 (before executor fixes) | v5 (executor fixes) |
|---|---:|---:|
| solo mean reach | 2333 (4 of 12 seeds reach the wall) | 3208 (12 of 12) |
| solo deaths | 107 (51 at the wall x≥2900) | 192 (125 at the wall) |
| solo deaths before x<2400 | 56 | 67 |
| duo mean reach | 2881 | 3147 |
| duo deaths | 296 (165 falls, 90 respawn loops) | 157 (53 falls, 0 respawn loops) |
| partner deaths | 399 | 267 |

Duo — the product mode — improves on every dimension. Solo reaches the wall on
every seed and then dies there repeatedly, because the wall fight itself is still
unsolved; it also loses ~11 more deaths in the 2000–2400 stretch. The ledger's
"no regression on any dimension" rule therefore records v5 as rejected on
`solo deaths 192 > 107`. That verdict is kept as written (the gate is doing its job),
and the ledger now names the failing dimension and splits deaths into "within the
reference's reach" vs "beyond it" so this pattern is visible next time. Reopening
the wall fight is the next policy task; accepting v5 is a judgement the numbers
above support for duo and do not settle for solo.

### Jev off/on paired comparison (`train compare`, 12 solo + 12 duo pairs, 3600 frames)

| | Jev off | Jev on |
|---|---:|---:|
| mean progress | 1907 | 1914 |
| AI deaths | 22 | 22 |
| partner deaths | 12 | 10 |
| paired team-death difference | | −0.08 (approx. 95 % −0.39 … +0.23) |

Jev (`typesafe/jev-1.13-20260917`) answered 378 times; 295 answers were accepted,
83 rejected as stale (answer age 617–2450 ms, median 750 ms), 5 failed. Offered
goals were route 378×, regroup 331×, collect 48×, cover 2×; it chose route 316×,
regroup 60×, collect 1×, cover 1×. In a 60-second window on stage 1 the route
goal is what the reflex layer would do anyway, so the on/off arms are close to
identical. Read this as **neutral, not as a demonstration**: the integration now
works (fresh plans, epoch checks, forecasts attached in 259 of 378 asks), but the
decision points where Jev's choice could matter — the wall, the corridor, the
cover/collect tradeoffs — are rarely inside 3600 frames. The demonstration claim
needs full-length episodes and the step-4 arms (heuristic vs Jev vs random).

## Primary documentation consulted

- https://docs.typesafe.ai/llms.txt
- https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md
- https://docs.typesafe.ai/model-jaggedness/jev-1.13.md
- Project-local `skills/typesafe-ai/SKILL.md`

The known-limitations page explicitly applies to jev-1.13. The project config
uses the floating alias jev-latest; the exact served version was not established
by these logs. The page supports the design recommendation to keep arithmetic in
code and align instructions with criteria; it is not proof of a particular
failure in the current served model.
