# Bayesian Battle Analyzer

A battle companion that starts from Smogon usage statistics and updates its beliefs about
every opponent Pokémon (forme, item, ability, moves, stat spread, Tera) as you log what
happens, turn by turn.

Everything runs in the browser. Teams and battles are stored in `localStorage`, like
Showdown's teambuilder: no accounts, no server. Pokepaste links import directly.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests against real usage data
npm run build      # static site in dist/ (deploy anywhere, e.g. GitHub Pages)
npm run data       # re-download the latest Smogon stats (monthly)
```

## How it works

For each opponent Pokémon the engine enumerates hypotheses

    h = (forme, stat spread, item, ability)

and keeps `posterior(h) ∝ prior(h) · Π P(observation | h)`, recomputed from scratch whenever
the log changes (so deleting or editing an old event just works; per-event likelihoods are cached).

**Priors** (`src/engine/prior.ts`) come from Smogon's monthly "chaos" stats:

- *Formes.* Team preview shows the base species, so a "Charizard" is really a mixture over
  Mega Y / Mega X / base, weighted by usage and (naive-Bayes) by its previewed teammates.
- *Spreads.* The ~160 most common spreads, plus spreads sampled from per-stat marginals for
  the long tail, plus a few generic templates, so an unusual spread is never impossible.
- *Moves.* A 4-move set is modelled as a conditional-Poisson sample whose weights reproduce
  the usage percentages. Seeing moves is a proper likelihood `P(seen ⊆ set)` and the unseen
  slots get honest predictions. Items reweight moves (Assault Vest can't run Protect; Choice
  items almost never do but love Trick), so **revealing a move shifts item beliefs**.
- *Item Clause* (VGC/BSS): items are coupled across the whole team with an exact
  constrained computation. Reveal Incineroar's Sitrus and nobody else can have one.

**Likelihoods** (`src/engine/likelihood.ts`), all using `@smogon/calc` for the mechanics:

| You log | What it tells the engine |
| --- | --- |
| Opponent hits you | Your HP is exact, so the 16 damage rolls pin down its Atk/SpA, item and ability. |
| You hit the opponent | HP% before/after (Showdown's exact rounding, or ±tolerance for an eyeballed bar) constrains HP × Def/SpD, Assault Vest, resist berries… |
| Turn order | Faster/slower than your known Speed (priority, Prankster, Trick Room, Tailwind, Scarf, paralysis). Opponent-vs-opponent order uses a mean-field approximation. |
| Item messages | Life Orb recoil, resist berry, Sitrus, Weakness Policy, Focus Sash, Rocky Helmet. A message that *should* have appeared but didn't is evidence too. |
| Two different moves without switching | Not a Choice item. |
| Acting without Mega Evolving | Weak evidence against a Mega forme. |
| Reveals / rule-outs | Items, abilities, moves, formes, Tera types, directly. |

Every observation has a small error floor, so one mis-entered number degrades beliefs
instead of zeroing out the truth. The log flags observations that almost nothing explains
("double-check crit, boosts, field or Helping Hand").

The right-hand panel also shows **posterior-predictive matchups**: the chance it outspeeds
each of your Pokémon, and damage ranges and KO chances in both directions, integrated over
both the damage rolls and what it might be running.

## Formats

`scripts/build-data.mjs` compiles these (edit the list to add more):

- Champions VGC 2026 Reg M-B (and Bo3), Champions BSS Reg M-B, Champions OU (Stat Points, level 50)
- SV OU, SV Doubles OU (EVs, level 100, Tera)

Smogon's stats server has no CORS headers, which is why the stats are pre-compiled into
`public/data/` rather than fetched live.

## Known limitations / next steps

- **Priors only condition on teammates for the forme choice.** Usage stats are per-Pokémon
  marginals, so "items given teammates" or "spread given item" aren't in the data. The fix is
  a joint corpus: Showdown's Bo3 VGC formats force open team sheets, so their replays contain
  full sets plus teammates, and a scraper could turn those into exemplar teams for the prior.
- HP of an opponent across several hits is treated per hit (uniform within the displayed %),
  not tracked exactly per hypothesis.
- Not modelled yet: Quick Claw and similar random ordering (covered only by the error floor),
  Illusion, Transform, Ruin abilities from partners, opponent's moves hitting its own partner.
- Deleting a log entry doesn't roll back HP/boosts in the live state; edit the card instead.
