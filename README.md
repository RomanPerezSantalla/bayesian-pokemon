# Bayesian Battle Analyzer

A phone-first companion for **Pokémon Champions ranked battles** (Singles and Doubles) on the
Switch. You tap in what happens on screen; it keeps the battle state and infers each opponent's
forme, item, ability, moves and stat spread as the battle goes.

- Priors come from the **official in-game ranked Battle Data**, refreshed daily.
- Hard logic where the game is deterministic: outspeeding a 189-Speed Sneasler with no speed
  modifiers on the field *is* Choice Scarf, 100%. Mega Evolving *is* the stone. Getting poisoned
  by Close Combat *is* Poison Touch.
- No accounts: teams and battles live in your browser, like Showdown, with a backup file to keep
  them safe or move them to another device. Pokepaste links import directly.

```bash
npm install
npm run dev          # http://localhost:5173  (add `-- --host` to open it from your phone on the same Wi-Fi)
npm test             # every move and item the calc has for Champions has its own test (src/engine/moves.test.ts, items.test.ts)
npm run build        # static site in dist/
npm run phone        # the app on your phone over HTTPS (voice included), with a test log; see below
npm run voice-pack   # the voice model's files (~150 MB, fetched once into .cache/voice/); see "By voice"
npm run data         # refresh the Showdown structure data + move/ability tables (monthly)
npm run data:tables  # just the move/ability tables (no download)
```

## Deploying, and your phone

It's a static site: `npm run build` puts everything in `dist/`, with relative paths, so any static
host and any path work. On **Cloudflare Pages**, connect the repo with build command
`npm run build && npm run voice-pack -- dist/voice` and output directory `dist`; every push to `main`
then publishes. The second half puts the voice model on the site, in parts under Pages' 25 MiB limit
(it fetches it from its sources during the build and checks every file's SHA-256); without it the app
still works, and voice offers only the browser's recogniser. Open the URL on your phone and
"Add to Home Screen": it installs as an app and works offline once loaded. (GitHub only runs the
tests and a build on each push, `.github/workflows/ci.yml`; it doesn't deploy anything.)

- **`functions/`** is a Cloudflare Pages Function that Pages picks up by itself: the site serves the
  in-game Battle Data at `/official/…`, cached at Cloudflare's edge (the index for an hour, a dated
  snapshot for a day). The fan site behind it, championsbattledata.com, then sees about one request
  per Cloudflare location instead of one per visitor, and its hiccups don't reach anyone. On any other
  host the app fetches the fan site directly, as it does if the function fails. `npm run dev` and
  `npm run preview` proxy `/official/` the same way (without the cache). To check it after deploying,
  open `/official/index.json` on your site.
- **Link previews:** set `SITE_URL` (your address, e.g. `https://example.com/`) in the Pages project's
  environment variables, and shared links get the page's address and icon (`og:url`, `og:image`);
  the title and description are there either way.

### Testing on your phone before deploying

`npm run phone` builds a test copy of the app, serves it from your PC and opens a free Cloudflare quick
tunnel to it (HTTPS, which voice and the offline install need; no account, works on mobile data too).
Scan the QR code it prints with the phone's camera. The first run downloads `cloudflared` through npx
(or install it: `winget install --id Cloudflare.cloudflared`), and the voice model into `.cache/voice/`.
The first time you turn voice on, the phone downloads the model from your PC through the tunnel (about
150 MB, as fast as your PC's upload); after that it's on the phone.

- The test copy is rebuilt whenever a source file changes: reload the page on the phone to get it (pull
  down on any page but a battle, where pull-to-refresh is off so a stray pull can't reload mid-turn).
- It reports back to the PC: each voice phrase (what the recogniser heard, its alternatives, and what it
  logged) with undos and errors, in `.cache/phone-log.jsonl`, with a line in the terminal as they
  happen; each battle as it's saved, in `.cache/phone-battles/`. With the voice model, each line's audio
  goes to `.cache/phone-audio/` too (it stays on your PC), with what the model heard and how long it took
  in the log, so the reading can be tuned on your voice. A test can be gone through afterwards from
  those. Normal builds have none of this.
- The tunnel's address changes every run, and the phone keeps each address's data apart: keep it running
  for a whole test session, or carry teams and battles over with a backup file.
- The QR code shows only once the address works. Opened sooner, a Wi-Fi router can take the address for
  one that doesn't exist and remember that for up to half an hour. If the phone still says so, use
  mobile data or run it again for a new address.
- Anyone with the address can open it while it runs; Ctrl+C stops everything.
- `npm run phone -- --local` skips the tunnel (this PC only, at http://localhost:4180).

`npm run dev -- --host` on the same Wi-Fi also works for everything but voice.

**On a phone, during a battle:** the screen stays on while a battle is open (until five minutes pass with
nothing logged or tapped) and while voice is listening, since phones lock after half a minute untouched.
Voice lets go of the microphone when the screen locks or you switch apps, and picks up again on return
(if the phone wants a fresh tap, it says so). With the game's sound on speakers, use headphones, so the
microphone hears you rather than the game.

## Logging a turn fast

1. **Tap who acted, in the order they act on screen** (the tiles mirror the Switch: them on top, you
   below). The order you log is the move order the Speed inference reads.
2. **Tap the move.** Theirs are sorted by how likely they are to have it; revealed ones first.
   Self/field moves (Protect, Tailwind, Trick Room, Swords Dance…) are logged on that tap. A Pokémon
   that certainly holds a Choice item opens straight on the move it's locked into (`‹ back` for another).
3. **Type the HP left** on the keypad (your exact HP; their % exactly as shown). Spread moves get one row per target;
   a number that can't take another digit (their 45%, your 142 of 202) moves on to the next row by itself,
   and `✓ Log` lights up when every row is filled. `KO`, `✦ Crit`, `No effect`, `Missed / protected` are one tap.
   No time? **skip HP** logs the move and order without it: that Pokémon's HP shows `?` until the next
   reading, which only resyncs it, so nothing wrong is learned.
4. `✓ Log`. The sheet stays open on whoever should move next (predicted from Speed), with everyone still
   to move one tap away; it closes when everyone has moved and *End turn* pulses (a Fake Out flinch counts).
   Tapping someone who already moved this turn, or who came in this turn, starts the next turn for you.
   A short vibration confirms each entry (Android).

**By voice:** tap **🎙 Voice** and read the battle text as it appears, adding HP where you
have it: "The opposing Salamence used Draco Meteor! Charizard 45", "Garchomp used Earthquake! It
doesn't affect the opposing Salamence… the opposing Rillaboom 60", "A critical hit!", "Charizard
fainted!", "Kim sent out Kingambit!", "Go! Incineroar!", "Charizard has Mega Evolved into Mega
Charizard Y!". The ability and item pop-ups ("Salamence's Intimidate", "Rillaboom's Leftovers") answer
the *What did the game show?* questions. Each move is logged when the next one starts or after a short
pause; HP left out is logged as skipped, and a message not said (Life Orb recoil, a berry) is never
taken as not having happened. The leads can come the same way: start the battle without them and read
the opening lines ("Kim sent out Salamence and Rillaboom!", "Go! Incineroar and Sneasler!"), or say
them your way ("opponent sent Rillaboom and Corviknight", "opponent leads with…", or just the names
while their places are empty). A species both sides have is the side just talked about ("opponent…
Altaria"), else yours; for a pop-up, which names no side, the one it fits.

Details said after a move was logged (after the pause, or once the next line started) go with it:
"…it crit", "Dragapult 40", "it missed", "Charizard fainted", "Sitrus Berry" reopen the last move logged,
if it's about who was in it, and log it again with that added. The turn's order can be said in words
too: "Rillaboom moved first", "Kingambit went last", "Rillaboom outsped Dragapult", "Gholdengo moved
before Kingambit" move a logged move as the log's *It went earlier / later* does (refused, with why,
when the HP typed in only fits the order logged); said before that Pokémon's move, it's placed there
once it's logged.

The rest of the game's lines can be read out as they come, in order, and are taken as the game means
them. They're worded as Champions has them (its own English battle text, as dumped in
[projectpokemon/champout](https://github.com/projectpokemon/champout)); every one of its battle lines
was checked to read as what it says, and `src/ui/battle/voice/turns.test.ts` reads whole turns:

- **Stat changes** ("The opposing Garchomp's Attack harshly fell!", "Charizard and Incineroar's Attack
  fell!", "…won't go any higher!") are checked against what logging already did (a move's own boosts
  and drops, Intimidate on the way in, Sticky Web, a Defiant answered), so nothing counts twice. A chance one goes with its move (Moonblast's Sp. Atk
  drop, Meteor Mash's Attack) and, like any stat change on a target, says whom a single-target move hit
  (Parting Shot's target); "Attack rose sharply!" after a drop, from one that may have Defiant, is its
  Defiant. What nothing logged explains (Moxie, Speed Boost, a seed) goes onto the board, after the move.
- **Hits**: "A critical hit on the opposing Kingambit!", "It's super effective on the opposing Kingambit
  and Salamence!", "…protected itself!", "But it failed to affect…", "The Pokémon was hit 4 times!", "But
  it failed!", "Occa Berry weakened Heat Wave's power!" (the berry of whoever it hit), "…knocked off the
  opposing Salamence's Life Orb!", "…'s Air Balloon popped!"; the user's HP said after its move ("…was
  damaged by the recoil! Incineroar 150") sets its HP. HP read after a Sitrus Berry's pop-up is the HP it
  settled on once healed.
- **Couldn't move**: "…flinched and couldn't move!", "…couldn't move because it's paralyzed!", "…is fast
  asleep." log no move (and no status on the move before); "…woke up!", "…'s Lum Berry cured its
  paralysis!" end it; "…cannot be poisoned!", "…is already asleep!" mean the move didn't take.
- **The field** as the game describes it (weather, terrain, the rooms, Gravity, Tailwind, screens and
  hazards starting or ending: "It started to rain!", "The twisted dimensions returned to normal!", "A
  tailwind started blowing on the opposing side!", "Your side's tailwind petered out!", "Pointed stones
  float in the air on the opposing side!", "…blew away Stealth Rock!") puts the board right wherever it
  differs.
- **Turns**: Champions writes nothing between turns (the weather stays on the field panel, with no
  "Rain continues to fall."), so a turn's end is told by what comes: its first end-of-turn line ("The
  rain stopped.", "…is buffeted by the sandstorm!", "…was hurt by its burn!", "…was hurt by its
  poisoning!", a Leftovers or Speed Boost pop-up, a tailwind or screen running out) ends it, with its
  residual damage and timers, and HP read after that is where that Pokémon is now, not part of a move.
  Otherwise the next turn shows itself: its switches ("…, come back!", "Kim withdrew…"), its Mega
  Evolution, or a Pokémon moving again, including one that couldn't move before. "Next turn" (or "end
  turn") said out loud ends one too.
- Trainer names ("…went back to Roman!", "…is reacting to Roman's Omni Ring!") are read past.

*Team preview* takes voice too: tap 🎙 Voice there and say their six as you see them ("Rillaboom,
Sneasler, Salamence…"; formes the way you'd say them: "Alolan Ninetales", "Wash Rotom", "Aqua Tauros"),
then "mine" (or "I brought…") and yours in the order you pick them on the Switch, which gives the ones
you bring and your leads; after "mine", a pause doesn't send the next names back to theirs. A Pokémon
with a female forme too (Indeedee, Basculegion) is said plain for whichever is used more; say "female" or
"male" for the other. "Scratch that" takes back the last one, "clear" starts over. When it can't tell
which Pokémon a word was, it offers the likeliest few to tap. The microphone stays on into the battle:
reading or saying its first line ("…sent out…", "opponent sent…") starts it and sets their leads.

**The voice model.** Voice runs a speech model on the device: the first time you turn it on, it offers a
one-time download (about 150 MB: NVIDIA's Parakeet TDT-CTC 110M, an 8-bit ONNX copy of its CTC half,
a speech detector and the ONNX runtime), kept in the browser's Cache Storage and removable from the
Battles page. Nothing leaves the device, it works offline, and in any browser (Chrome, Safari, Firefox).
It listens out for what can be said right now: in a battle, the dozen Pokémon in it, your moves, items
and abilities and their likely ones; at team preview, every Pokémon in the format. A general recogniser
writes names it doesn't know the way they sounded ("Corvy Kight", "King Ambot", "Rail a boom"); here
each name that can come up is also lined up against the sound itself (`src/speech/ctc.ts`, word
spotting as in NVIDIA's CTC-WS), and one that fits nearly as well as what was heard replaces it. That's
what holds up for accents: names are compared on the sound, among the few possible, not on spelling. On
synthetic voices, an American one and a Spanish one reading English, it gets 98 of 106 names and moves
with nothing false, also on lines with no names in them. The speech detector finds where each line ends
(a pause of 0.7 s), and the line is read in a fraction of a second on a PC, a second or so on a phone.

The browser's own recogniser (Chrome, Safari) is still there for anyone who'd rather not download: the
offer has a link for it, and the Battles page switches between the two. It sends the audio away (Chrome
to Google), needs a connection, and mangles names ("carbonite" for Corviknight, "dragon ball" for
Dragapult, "Celtic" for Milotic); names are then matched among the few that can be meant, by their
consonant sounds as well, which rescues many, and Chrome on Android's phrases in pieces ("King",
" Gambit") are put together. Either way, English game text, and with the game audio on speakers, use
headphones.

**On a PC, the keyboard does it all:** Q W open their Pokémon and A S yours (left to right), 1–9 pick a
move or target, typing a letter searches every move, ← → switch Pokémon; then type the HP, Tab for the
next target, K for KO, C crit, X missed, S skip HP, Enter logs, Esc closes. E ends the turn, Ctrl+Z undoes.

**Turn order.** Tiles show 1st / 2nd / 3rd… as Pokémon move, and the log numbers each move within
its turn. Tap a logged move to fix it: *It went earlier / later* swaps it with its neighbour (the
swapped moves are re-run, so the snapshots and undo stay exact), and *Order unsure* keeps it out of
the Speed inference. Every pair of moves in a turn is compared, by priority bracket first (Protect,
Fake Out, Prankster, Gale Wings, Grassy Glide in Grassy Terrain…), then Speed on the field as it was
at the earlier move (Trick Room, Tailwind, paralysis, Icy Wind mid-turn). A Mega Evolution counts from
the start of its turn, whenever you log it. When the game says Quick Claw or Quick Draw let a Pokémon
move first, tick that chip before its move: it pins the item or ability and puts the move first in
its bracket. Stall always moves last in its bracket, even under Trick Room.

Only relevant chips show up: *Life Orb recoil* only while Life Orb is still possible, *Berry weakened
it* only when a resist berry is, statuses only if the move or a possible ability can inflict them.
A chip left off means that message didn't appear, which is evidence too.

**Abilities before the turn starts.** When Pokémon come in, a *What did the game show?* row asks about
abilities that announce themselves (Intimidate, Drought/Drizzle/sand/snow, terrain setters, Pressure,
Unnerve, Air Balloon…). One tap applies the effect and pins the ability; *nothing* rules all of those out.
Nothing is assumed from usage odds: a Rillaboom that's Grassy Surge >99% of the time still gets asked,
and only an ability already known for certain is applied without a tap. Opponents hit by your Intimidate get
the same row for reactions (Defiant, Competitive, Clear Body, Clear Amulet, White Herb…), and moves with
guaranteed stat drops (Icy Wind, Snarl…) show those chips on the target.

**Megas** have two abilities in play: the one they enter with (uncertain, e.g. Intimidate vs Moxie) and
their Mega's own (fixed). They're tracked separately, so an Intimidate before Mega Evolving never
contradicts Aerilate after.

**At a glance:** the move order of everyone on the field (by Speed, flipped under Trick Room, with odds
where it's close). Per opponent, damage comes first as one card per Pokémon of yours on the field: what
it *takes* from the opponent's likeliest moves and what it *deals* back, each a 95% range of max HP (over
damage rolls and its possible sets) with an HP bar (solid = surely left, striped = depends on the roll
and their set). Each move carries its type symbol, as the Switch games draw it, with the type
multiplier beside it (the type as it lands: Aerilate's Flying Hyper Voice shows as Flying). The badge
gives the KO chance from its HP now, or else how many hits it takes (2HKO, 2–3HKO…); rows needing four
hits or more fade, and a card's edge turns orange/red when a likely move could KO it. Every attack it
plausibly has is listed (3%+), since on turn one nothing is known. The card header names who moves
first. Any Pokémon that can still Mega Evolve, yours or theirs, is counted as its Mega for damage and
Speed (it evolves before anyone moves), weather included for Drought and co. Then Speed for your other Pokémon, and item (with icons), ability and moves.

The header has a light/dark toggle (it starts from the system setting and remembers your choice) and
a Buy me a coffee link.

**After the battle:** the collapsed details hold 95% ranges for every stat and its stat points, drawn
inside the prior range, plus the likeliest spreads and the evidence behind them, for reverse-engineering
a team. Spreads are modelled jointly, so the 66-point budget ties the stats together: learning it maxed
SpA and Speed leaves almost nothing for the rest.

Handled automatically: stat drops/boosts from moves (Icy Wind, Snarl, Close Combat, Parting Shot…), and
stages set, copied, reset or swapped (Belly Drum, Curse, Psych Up, Haze, Clear Smog, Topsy-Turvy, Guard and
Power Swap); statuses, cured at once by a status berry that's known to be held; Tailwind / Trick Room /
Magic Room / Wonder Room / Gravity / weather / terrain / screens with turn counters (8 turns with a
weather rock, Light Clay or Terrain Extender the setter is known to hold); entry hazards (Stealth Rock by
type, Spikes by layers, Toxic Spikes, Sticky Web) on the way in, cleared by Rapid Spin, Mortal Spin,
Defog and Tidy Up, swapped by Court Change. There are no Heavy-Duty Boots in Champions, so hazards are
certain from types, except where an ability or item of theirs not known yet could change it (Magic
Guard, Levitate, an Air Balloon): then its HP is left to be read. Intimidate and weather/terrain
abilities once the game shows them (a Mega's own on evolving); Sitrus, Oran, Focus Sash and Air Balloon
on your side; Life Orb recoil on yours; Knock Off, Thief and Fling taking items (a Mega Stone stays);
HP paid for Substitute, Belly Drum, Steel Beam and the like; the user fainting from Explosion, Memento,
Final Gambit or Healing Wish; Helping Hand from a partner; end-of-turn Leftovers / burn / poison / sand /
Grassy Terrain. A move that drains or recoils changes its user's HP by a share of damage only known in %:
its HP shows `?` until it's read again (type it as the "before" to keep the next hit as evidence).
Everything is undoable (`↶`), exactly.

## Your data

Battles are saved in the browser's IndexedDB as they change, one record per battle; teams in
localStorage. Leaving the app (switching apps, locking the phone) writes straight away. If the browser drops
the database connection (Safari does after a while in the background), the next save reconnects; if saving
still fails, it's retried every few seconds and a banner says so, and *Save backup* still includes the
battles that couldn't be written. In memory each entry keeps whole copies of the battle state (for undo, and for what the
inference saw at the time); saved, each copy is just what changed since the one before, so a 12-turn
Doubles battle takes about 25 KB instead of 190 KB. Earlier versions kept everything in localStorage
(5 MB, full after a few dozen battles); their battles move over on the first load. Once the first
battle is saved the app asks the browser to keep its data even when space runs low (Chrome decides by
itself, Firefox asks). Safari can still clear a website's data after a week unused unless the app is on
the home screen, which is one more reason for backups.

**Backups.** The Battles page has *Save backup* (one JSON file with every team and battle; on iPhone
and iPad it opens the share sheet, so it can go to Files) and *Restore from file…*, which merges by id,
keeping whichever copy was changed last. A bug report restores the same way.

**When something breaks.** A screen that throws shows what broke instead of going blank, with
*Undo the last entry* (if what was just logged broke it), *Copy this battle for a bug report* (the
error, the build, the browser and the battle; it's saved as a file where the clipboard is blocked)
and *Reload*. An error from a tap shows a banner with the same report. Saved battles are safe either way.

## How the inference works

For every opponent Pokémon the engine enumerates hypotheses *h = (forme, stat spread, item, ability)*
and keeps `posterior(h) ∝ prior(h) · Π P(observation | h)`, recomputed in a Web Worker on every
change so the screen never waits.

**Priors** (`src/data/fuse.ts`, `src/engine/prior.ts`)

- *Official ladder* ([championsbattledata.com](https://championsbattledata.com), a fan mirror of the
  in-game Battle Data): top moves, items, abilities, stat alignments, stat-point spreads and teammates
  per Pokémon, separately for Singles and Doubles. Fetched from the browser and cached for offline use.
- *Showdown* (Smogon's usage stats for the newest Champions regulation, compiled at build time): the
  structure the in-game lists lack. How Mega X and Mega Y users differ, which alignment goes with
  which spread, and the long tail of spreads.
- Formes follow the Mega Stones held (Charizardite Y 94% → Mega Y 94%). Every legal ability stays
  possible (a share listed as 0.0% was still seen, just rarely), and spread tails and templates keep
  unusual builds possible too.
- Move sets are modelled as 4-move samples that reproduce the usage percentages, with item rules
  (Choice Scarf users don't run Protect), so seeing a move moves the item beliefs.
- Item Clause couples everyone's items exactly.

**Observations** (`src/engine/likelihood.ts`) are exact:

| You log | What it pins down |
| --- | --- |
| Their attack on you | your exact HP loss → their Atk/SpA, item, ability, Mega forme |
| Your attack on them | their HP% as the game shows it (rounded down, never 0% while alive, 100% only at full) → HP × Def/SpD, berries, Sash |
| Turn order | faster/slower than your known Speed, or than their partner |
| Item and ability messages | Life Orb, resist berries, Sitrus, Sash, Weakness Policy, Rocky Helmet, banners |
| Statuses | Poison Touch, Flame Body, Static, Poison Point, Effect Spore… |
| Two moves without switching | not Choice Scarf |

If something you log is impossible given everything else (a typo, a forgotten Helping Hand, a
mechanic we don't model) it is **set aside and flagged in red** rather than wiping the beliefs.

## Data

- `public/data/formats.json`, `structure-*.json`: from `npm run data` (Smogon stats, latest month).
  Showdown publishes the previous month's stats in early month, so the Reg M-C structure arrives in
  October; until then it's Reg M-B's.
- `src/data/moves.gen.json`, `abilities.gen.json`: from `@pkmn/dex` and `@smogon/calc` (`npm run data:tables`),
  including each move's priority: the calc keeps only positive ones, and turn order needs Trick Room's −7.
- `@smogon/calc` 0.12's Champions data has 86 moves with no category. The 75 status moves among them are
  unaffected, but the 11 attacking ones have no type either, so the calc dealt 0 with them. Of those only
  Metal Claw is learnable in Champions (the other ten, Anchor Shot and the like, are in the calc's list
  though no Pokémon in Champions has them). `src/data/dex.ts` fills them in from the calc's gen 9 data.
- Official ladder data: live, not stored in this repo (through `/official/` on Cloudflare Pages).

## Known limitations

- Damage uses `@smogon/calc`'s Champions mechanics; unlogged modifiers (a partner's Friend Guard,
  Ruin abilities from partners) show up as flagged conflicts.
- Damage that isn't down to stats (Counter, Mirror Coat, Metal Burst, Comeuppance, Super Fang, Endeavor,
  one-hit KOs, Beat Up, Spit Up) is logged but learns nothing.
- Not tracked: accuracy and evasion stages, confusion and other volatile effects (Taunt, Encore,
  Substitute's doll, Leech Seed), Safeguard, Quick and Wide Guard, Fairy Lock, PP; Trick and Switcheroo's
  swap, a stolen item on the thief, Baton Pass's stages; Power Trick, Power and Guard Split, Speed Swap and
  moves that change types or abilities (Soak, Simple Beam, Skill Swap…). The per-item test lists the
  items with nothing to model and why.
- Quick Claw and Quick Draw count only when their chip is ticked (see *Turn order*); one left
  unticked reads as the Pokémon being faster (a Scarf, more Speed) or, where that can't be, as a
  flagged conflict.
- Illusion and Transform aren't modelled.

Credits: in-game Battle Data via championsbattledata.com (not affiliated with Nintendo, Game Freak or
The Pokémon Company), Smogon usage stats, `@smogon/calc`, `@pkmn/dex`, Showdown sprites and item icons, type symbols
recreated by [partywhale](https://github.com/partywhale/pokemon-type-icons) (MIT). Voice:
[Parakeet TDT-CTC 110M](https://huggingface.co/nvidia/parakeet-tdt_ctc-110m) by NVIDIA and Suno.ai
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), used as the CTC half converted to 8-bit ONNX by
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx); [Silero VAD](https://github.com/snakers4/silero-vad)
(MIT); [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
