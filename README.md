# Bayesian Battle Analyzer

A companion for **Pokémon Champions ranked battles** (Singles and Doubles), on a phone or a PC beside
the game. You tap in what happens on screen; it keeps the battle state and infers each opponent's
forme, item, ability, moves and stat spread as the battle goes. Reading the battle off the game's
window by itself is in the works (see *Reading the game's screen*).

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
npm run phone        # a test copy with a test log, on your phone over HTTPS (or this PC: -- --local); see below
npm run data         # refresh the Showdown structure data + move/ability tables (monthly)
npm run data:tables  # just the move/ability tables (no download)
npm run data:icons   # the icon table team preview's icons are matched against (fetches Showdown's renders once)
npm run data:leads   # common leads, from Showdown's public Champions VGC replays (fetched once into .cache/replays)
```

## Deploying, and your phone

It's a static site: `npm run build` puts everything in `dist/`, with relative paths, so any static
host and any path work. On **Cloudflare Pages**, connect the repo with build command `npm run build`
and output directory `dist`; every push to `main` then publishes. Open the URL on your phone and
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
tunnel to it (HTTPS, which the offline install needs; no account, works on mobile data too).
Scan the QR code it prints with the phone's camera. The first run downloads `cloudflared` through npx
(or install it: `winget install --id Cloudflare.cloudflared`).

- The test copy is rebuilt whenever a source file changes: reload the page on the phone to get it (pull
  down on any page but a battle, where pull-to-refresh is off so a stray pull can't reload mid-turn).
- It reports back to the PC: undos, errors and the screen capture's starts and stops in
  `.cache/phone-log.jsonl`, with a line in the terminal as they happen; each battle as it's saved, in
  `.cache/phone-battles/`; and while the game's screen is captured, its frames (twice a second, when
  something changed) in `.cache/screen-frames/`, a folder for each capture. It all stays on your PC, and a
  test can be gone through afterwards from it. Normal builds have none of this.
- The tunnel's address changes every run, and the phone keeps each address's data apart: keep it running
  for a whole test session, or carry teams and battles over with a backup file.
- The QR code shows only once the address works. Opened sooner, a Wi-Fi router can take the address for
  one that doesn't exist and remember that for up to half an hour. If the phone still says so, use
  mobile data or run it again for a new address.
- Anyone with the address can open it while it runs; Ctrl+C stops everything.
- `npm run phone -- --local` skips the tunnel (this PC only, at http://localhost:4180).

`npm run dev -- --host` on the same Wi-Fi also works, without the offline install.

**On a phone, during a battle:** the screen stays on while a battle is open, until five minutes pass with
nothing logged or tapped, since phones lock after half a minute untouched.

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
Unnerve, Air Balloon…). One tap applies the effect and pins the ability; *nothing* rules all of those out. A battle
read off the game's screen answers these itself: every line is read, so one that came in with no pop-up showed
nothing (once the moves are being chosen, or a move is used), and the row never shows. A terrain seed counts too:
in its terrain it goes off on the way in, or as the terrain starts with it out, so none shown is none held (a
Volcarona sent out beside Grassy Surge with no Grassy Seed pop-up has none). A weather or terrain setter coming in
to its own weather or terrain sets nothing and says nothing (Rillaboom back into its own grass): no pop-up is no
evidence then. Trace's pop-up is followed by the copied one's ("…'s Prankster", yours): that one isn't its own, nor
is any ability none of its formes can have (Trace's copy with Trace's own pop-up unread, a Skill Swap).
Nothing is assumed from usage odds: a Rillaboom that's Grassy Surge >99% of the time still gets asked,
and only an ability already known for certain is applied without a tap. Opponents hit by your Intimidate get
the same row for reactions (Defiant, Competitive, Clear Body, Clear Amulet, White Herb…), and moves with
guaranteed stat drops (Icy Wind, Snarl…) show those chips on the target.

**Megas** have two abilities in play: the one they enter with (uncertain, e.g. Intimidate vs Moxie) and
their Mega's own (fixed). They're tracked separately, so an Intimidate before Mega Evolving never
contradicts Aerilate after.

**Any of theirs**, from the buttons over the panel on the right: one on the field, or one benched, which stays
shown until you pick another (picked on the field, it gives way to the field's once it leaves).

**Their leads (doubles).** At team preview, a panel over their side shows the five pairs they're likeliest to lead
with. Once their leads are out, it shows how likely each of the other four is to be one of the two in the back
(one of them in, the other's odds among the three left), until both have come in. The odds come from Showdown's
public Champions VGC replays: how often each species leads when it's in the six, or comes in from the back when it
didn't lead, and which pairs go together more or less often than that (a weather setter and its partner lead
together; two Fake Out users rarely do). Take them as leanings: players pick leads for the matchup, and even one
player with one team repeated a lead under a third of the time. Tested on players it wasn't counted from, the real
lead pair was in its top five 53% of the time (33% at random) and its first pick was right 16% of the time (7%);
its likeliest back two were right 30% of the time (17%).

**At a glance:** the move order of everyone on the field (by Speed, flipped under Trick Room, with odds
where it's close). Per opponent, damage comes first as one card per Pokémon of yours on the field: what
it *takes* from the opponent's likeliest moves and what it *deals* back, each a 95% range of max HP
(over damage rolls and its possible sets) with an HP bar (solid = surely left, striped = depends on the
roll and their set). Each move carries its type symbol, as the Switch games draw it, with the type
multiplier beside it as the hit lands (Aerilate's Hyper Voice shows as Flying; Mega Lopunny's Scrappy
Close Combat on a Ghost as ×2, not the chart's ×0; Ring Target, Gravity, Freeze-Dry likewise). The badge
gives the KO chance from its HP now, or else how many hits it takes (2HKO, 2–3HKO…); rows needing four
hits or more fade, and a card's edge turns orange/red when a likely move could KO it. Every attack it
plausibly has is listed (3%+), since on turn one nothing is known. The card header names who moves
first. A Pokémon that can still Mega Evolve is counted as its Mega for damage and Speed (it evolves
before anyone moves), weather included for Drought and co., until it moves without doing so: then it's
counted as it is (the stone may be kept for another, or for later), and the note says so. Only one of
yours on the field is counted, the first that hasn't let a turn go by, since a side has one Mega. The
note's switch, and the *as Mega* / *not Mega* tag on your cards, count it the other way. Then Speed for
your other Pokémon, and item (with icons), ability and moves.

The header has a light/dark toggle (it starts from the system setting and remembers your choice) and
a Buy me a coffee link.

**After the battle:** the collapsed details hold 95% ranges for every stat and its stat points, drawn
inside the prior range, plus the likeliest spreads and the evidence behind them, for reverse-engineering
a team. Spreads are modelled jointly, so the 66-point budget ties the stats together: learning it maxed
SpA and Speed leaves almost nothing for the rest.

Handled automatically: stat drops/boosts from moves (Icy Wind, Snarl, Close Combat, Parting Shot…), and stages
set, copied, reset or swapped (Belly Drum, Curse, Psych Up, Haze, Clear Smog, Topsy-Turvy, Guard and Power
Swap); statuses, cured at once by a status berry that's known to be held; Tailwind / Trick Room / Magic Room /
Wonder Room / Gravity / weather / terrain / screens with turn counters (8 turns with a weather rock, Light Clay
or Terrain Extender the setter is known to hold), shown between their Pokémon and yours. One of theirs whose
item isn't known may hold it: their screen shows "2 or 5" turns left, and is kept up past its 5th turn until the
game says it's over. Ended right then ("The opposing side's Light Screen wore off!"), it had no Light Clay;
still up with no such line, it had, and that's shown (on 6 Oct a Sableye's Light Screen lasted 8 turns, and had
been taken off after 5). Rain from a Drizzle the game shows is timed the same way (Damp Rock), and yours by your
item. Weather or terrain set into itself (Pelipper back into its own rain) fails, and its timer carries on.
Contrary turns stat changes round, and Simple doubles them, once the ability is known (a Mega Staraptor's is
Contrary: its Close Combat raises its defences). Held by a binding move (Infestation, Fire Spin, Whirlpool, Sand
Tomb, Wrap, Bind, Snap Trap): it's tagged with the move and the turns to come (4 or 5 in all, 7 with a Grip
Claw), loses 1/8 of its HP at each turn's end (1/6 with a Binding Band) while its binder stays in, and is let go
when it or its binder leaves, or the game says "…was freed from Infestation!" (that turn unhurt). Leech Seed
(not on a Grass type) and Salt Cure (1/4 on a Water or Steel type) take 1/8 a turn until it leaves; Rapid Spin
and Mortal Spin free their user. Statuses show in the games' colours (burn orange, poison purple, paralysis
yellow, sleep grey, freeze blue). And: Baton Pass's stat stages, passed to the one sent in; Glaive Rush's
opening (its user takes double damage until it moves again); Aegislash's Stance Change (it attacks in its Blade
forme and stays in it, taking hits on its Blade forme's defences, until King's Shield); entry hazards (Stealth
Rock by type, Spikes by layers, Toxic Spikes, Sticky Web) on the way in, cleared by Rapid Spin, Mortal Spin,
Defog and Tidy Up, swapped by Court Change. There are no Heavy-Duty Boots in Champions, so hazards are certain
from types, except where an ability or item of theirs not known yet could change it (Magic Guard, Levitate, an
Air Balloon): then its HP is left to be read. Intimidate and weather/terrain abilities once the game shows them
(a Mega's own on evolving); Sitrus, Oran, Focus Sash and Air Balloon on your side; Life Orb recoil on yours;
Knock Off, Thief and Fling taking items (a Mega Stone stays); HP paid for Substitute, Belly Drum, Steel Beam and
the like; the user fainting from Explosion, Memento, Final Gambit or Healing Wish; Helping Hand from a partner;
end-of-turn Leftovers / burn / poison / sand / Grassy Terrain. A move that drains or recoils changes its user's
HP by a share of damage only known in %: its HP shows `?` until it's read again (type it as the "before" to keep
the next hit as evidence). Everything is undoable (`↶`), exactly.

## Reading the game's screen (in progress)

The game writes down everything that happens: every move, the ability and item pop-ups, stat changes,
faints, the weather. Tapping it in mid-battle takes the time that playing needs, so the app is to read it
off the game's window by itself (Champions in an Android emulator such as BlueStacks, on the same PC) and
have the battle logged whenever you look.

**▣ Capture game** in the top bar (in development and test copies for now) captures the window you pick in
the browser's share dialog, with a small preview in the corner to show it's the right one (if it stays black,
the browser can't capture that window: share the whole screen, or use Edge or Chrome). In the game, turn off
*Display Battle Names* (Gym > Submenu > Settings > Battle): its text then names every Pokémon by species,
which is what the reader goes by, where a nickname ("Bob", or one in another alphabet) would name none of
their six. Nothing to tap after that: when team preview comes up, the battle opens by itself with their six, your team (the saved one whose
names are on screen, a Mega or a regional forme by its species' name: "Garchomp" for Garchomp-Mega-Z) and, once
you've picked, the four you brought; the game's first lines set the leads, and
it's logged from then on, the battle screen showing what was read and what it logged. Recorded on BlueStacks
at 1920×1080, two whole ranked battles read back right, team preview included, turn by turn. Capturing can be
stopped and started again between battles. With team preview missed (capturing started late, the page
reloaded), the battle opens at the first "… sent out …!" with the ones it names, and the rest of theirs are
added as the text names them.

What it reads (`src/screen/`), a few times a second, off the main thread:

- **The message line**: the line that starts at its fixed margin, read once two readings agree (a line fading
  in over a moving scene never stands pixel-still), or, if it never settles, its likeliest reading as it goes.
  Its text is white, but for critical hits: "A critical hit!" is written in yellow, the one coloured line.
- **Pop-ups** ("Raichu's" over "Electric Surge"): two lines aligned to the owner's side, theirs prefixed
  "The opposing" (both sides can have a Raichu).
- **HP boxes**: theirs in %, yours in HP (the digits left of the slash), read once the count stops, or what
  they last showed as they go; a grey box (fainted) is 0, a KO. Whose box it is: the name read in it, else
  where it's shown (theirs face you, so their first is on the right). HP comes only from here, never from text.
  A box is a flat pink, violet or neutral grey strip with a name in it; theirs reads as digits and a "%", and
  a grey one only as 0 (the stadium in the rain is a bluish grey dotted with lights, and "8b1" isn't 8%). The
  number is read from just short of the slash (yours: "4 /202" was read as 47, the slash's start taken for a 7) and
  of the next box (theirs: "100% 1"). A box naming one of that side's Pokémon the log doesn't have out, and nothing
  like the one it has there, means its switch was read wrong or missed: it's logged as come in, where the box is.
- **Where the game's picture is** in the window, found again every few seconds but moved only when found in
  the same new place twice running (a dark scene, Draco Meteor's, can look like BlueStacks' own frame).
- **The move-select screen** ("MOVE TIME"): the turn is over.
- **Team preview**, both its screens (choosing, then standing by): their six have no names on screen, only an
  icon (a small 3D render), its types and its gender. The types are read by their symbols' colours (Scarlet and
  Violet's palette, which the game's symbols match to within a few levels), and the icon by its colours, which
  stay the same whatever the pose (the game's renders aren't posed as Showdown's are): each slot's colours, over
  a few frames so the lasers sweeping across are gone, against every species' normal and shiny renders
  (`src/data/icons.gen.json`, from `npm run data:icons`). Types, gender and colours add up to a fit, and the
  ladder's usage breaks near ties; all 24 slots of the recordings came out right, the shinies too. Yours are
  read by name (choosing) and by their numbers once picked (standing by), and the header says Doubles or
  Singles. Should a species be read wrong, the battle's text (or an HP box's name) puts it right: one of theirs it
  names that isn't among the six takes the place of one not seen yet (one read as possibly it, else one of its
  types). Names are compared as the game writes them: "Floette" is Floette-Eternal, "Arcanine" Arcanine-Hisui (on
  5 Oct a Floette-Eternal read as Alcremie was never put right, and its HP went to the Gholdengo beside it). A
  standing-by screen is only taken for one when each of their six is a panel of its own, with the stadium between
  them, and yours aren't crimson: the info screen on a Pokémon in battle is one crimson panel across all that, and
  once opened a battle against six it made up; and one never seen choosing, mid-battle, is never taken for it.

Text is read by PaddleOCR's PP-OCRv5 English recogniser (Apache 2.0, about 8 MB) on the device, with ONNX
Runtime's WebAssembly (one thread), fetched the first time a capture starts; `npm run dev` and `npm run phone`
serve both from `.cache/ocr/` and `node_modules`. Not yet: a public build of the reader.

What's read goes through the battle-text reader (`src/ui/battle/narration/`). It takes the game's own lines,
worded as Champions has them (its English battle text, as dumped in
[projectpokemon/champout](https://github.com/projectpokemon/champout): every one of its battle lines was
checked to read as what it says, and `turns.test.ts` reads whole turns), plus HP ("Charizard 45": yours in
HP, theirs in %), in the order the game shows them:

- **Moves**: "The opposing Salamence used Draco Meteor!", "Kim sent out Kingambit!", "Go! Incineroar!",
  "Charizard has Mega Evolved into Mega Charizard Y!" (which Mega: the stone shown just before, "…'s
  Garchompite Z is reacting to …'s Omni Ring!", since the line after calls Garchomp-Mega-Z plain "Mega Garchomp";
  else X or Y only when the line says which, otherwise both stay open). A Mega the format's data doesn't list
  (a new one) is believed all the same once it's shown, holding its own stone. Each move is logged when the next one starts, and HP or a detail read just
  after goes with it; HP not read is logged as skipped, and a message not read (Life Orb recoil, a berry)
  is never taken as not having happened. One into a Protect made this turn is logged as protected, with no
  HP to wait for; the same move read twice is one move; one an Encore made it use ("…must do an encore!")
  went at the priority of the move chosen before, so its place says nothing of Speed. A Pokémon sent in after
  its side's Baton Pass, U-turn or Parting Shot takes that one's place (yours are picked on the party screen,
  with no "…, come back!"). A two-turn move's charge ("…absorbed electricity!", "…flew up high!") is its turn,
  nothing hit yet, the attack its next; in the rain (Electro Shot) or the sun (Solar Beam) the hit comes in the
  same turn. Electro Shot's and Meteor Beam's Sp. Atk rise comes with the charge, before the hit: its damage is
  taken with it, and a Protect that stops the hit doesn't stop the rise; the charge line ("…absorbed electricity!") brings
  the rise with it, whether or not its "…'s Sp. Atk rose!" is read. (The calc puts that rise into the hit
  itself, so for a hit logged with it the calc is given the stage before it: on 5 Oct every Electro Shot had been
  taken at +2.) "… withdrew X!" is said only of theirs ("…, come back!" of yours), so of a species both sides have,
  it's theirs; a trainer's name before it isn't read in with the Pokémon's ("c.c. withdrew Avalugg!").
- **Hits**: "A critical hit on the opposing Kingambit!", "It's super effective on the opposing Kingambit
  and Salamence!", "…protected itself!", "But it failed to affect…", "The Pokémon was hit 4 times!", "But
  it failed!", "Occa Berry weakened Heat Wave's power!" (the berry of whoever it hit), "…knocked off the
  opposing Salamence's Life Orb!", "…'s Air Balloon popped!"; the user's HP read after its move ("…was
  damaged by the recoil! Incineroar 150") sets its HP. HP read after a Sitrus Berry's pop-up is the HP it
  settled on once healed.
- **Stat changes** ("The opposing Garchomp's Attack harshly fell!", "Charizard and Incineroar's Attack
  fell!", "…won't go any higher!") are checked against what logging already did (a move's own boosts and
  drops, Intimidate on the way in, Sticky Web, a Defiant answered), so nothing counts twice, and by as much
  as the game says, whatever the move does as the app has it (Champions' Make It Rain lowers Sp. Atk by 2,
  "harshly fell", where Scarlet and Violet's lowered it by 1; a Simple Pokémon's changes are doubled); "…'s Attack
  was not lowered!" takes back the drop logged for it this turn (and asks, for one of yours whose Mega's
  ability would have stopped it, whether it Mega Evolved). A chance one goes with its move (Moonblast's
  Sp. Atk drop, Meteor Mash's Attack) and, like any stat change on a target, says whom a single-target
  move hit (Parting Shot's target); "Attack rose sharply!" after a drop, from one that may have Defiant,
  is its Defiant. On one of theirs that may have Contrary, a line saying the opposite of a change logging made
  ("The opposing Staraptor's Defense and Sp. Def rose!" after its Close Combat) replaces it, and shows its
  ability (on 6 Oct, a Mega Staraptor's defences had been left at +0, and a Fake Out into it came out
  impossible). What nothing logged explains (Moxie, Speed Boost, a seed) goes onto the board, after
  the move. "Milotic copied Baxcalibur's stat changes!" (Psych Up, either side's, never called "the opposing")
  gives it the other's stages; "All stat changes on … were inverted!" (Topsy-Turvy) turns its own round.
- **What a Pokémon is**: its types as the game says they changed ("…transformed into the Ice type!" from
  Protean, Libero or Soak; "Ghost type was added to …!"; "…became the same type as …!"; "…burned itself out!",
  "…used up all its electricity!"), until it leaves the field. A change the app doesn't follow ("…transformed
  into Incineroar!" from Transform or Imposter, Power Trick, Power or Guard Split, a swap of stats with a target
  it doesn't name, Zero to Hero, a forme change) makes that Pokémon count for nothing until it leaves the field:
  what it deals and takes and when it moves aren't evidence, so nothing about it can turn up as impossible.
- **Out of turn**: "…took the kind offer!" (After You), "…'s move was postponed!" (Quash), "…followed …'s
  instructions!" (Instruct: its move once more, the same turn): that move went where something put it, so
  its place says nothing of Speed. "… and … switched places!" (Ally Switch) swaps the two of that side.
- **Couldn't move**: "…flinched and couldn't move!", "…couldn't move because it's paralyzed!", "…is fast
  asleep." log no move (and no status on the move before); "…woke up!", "…'s Lum Berry cured its
  paralysis!" end it; "…cannot be poisoned!", "…is already asleep!" mean the move didn't take.
- **Held**: "…has been afflicted with an infestation by…!", "…became trapped in the fiery vortex!", "…was
  wrapped by…!", "…was seeded!", "…is being salt cured!" say the move reached it (logging it holds it); "…was
  freed from Infestation!" lets it go.
- **The field** as the game describes it (weather, terrain, the rooms, Gravity, Tailwind, screens and
  hazards starting or ending: "It started to rain!", "The twisted dimensions returned to normal!", "A
  tailwind started blowing on the opposing side!", "Your side's tailwind petered out!", "Pointed stones
  float in the air on the opposing side!", "…blew away Stealth Rock!") puts the board right wherever it
  differs.
- **Turns**: Champions writes nothing between turns (the weather stays on the field panel, with no "Rain
  continues to fall."), so a turn's end is told by what comes: its first end-of-turn line ("The rain
  stopped.", "…is buffeted by the sandstorm!", "…was hurt by its burn!", "…was hurt by its poisoning!",
  a Leftovers or Speed Boost pop-up, "…had its HP restored." from Grassy Terrain or Leftovers, a tailwind or
  screen running out) ends it, with its residual damage and timers, and HP read after that is where that
  Pokémon is now, not part of a move (straight after a Sitrus Berry's pop-up, "…had its HP restored." is part
  of the move). Otherwise the next turn shows itself: its switches ("…, come back!", "Kim withdrew…"), its
  Mega Evolution, or a Pokémon moving again (including one that couldn't move before, or one that came in
  this turn); off the screen, the move-select screen ends it for certain. Entries
  undone take what was read about them with them: a turn undone and read again isn't split by the
  "…flinched" read the first time.
- Trainer names ("…went back to Roman!", "…is reacting to Roman's Omni Ring!") are read past.

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
- *Showdown* (Smogon's usage stats for the newest Champions regulation, compiled at build time): only
  what the in-game data can't say at all, because its shares aren't the ladder's (teams cost nothing to
  build there, so players experiment far more). That's how a Mega forme's moves and spreads differ from
  its species' (the in-game lists pool them: a Mega X and a Mega Y fight differently), the share each
  teammate rank stands for, and species the in-game data doesn't list.
- Formes follow the Mega Stones held (Charizardite Y 94% → Mega Y 94%), whatever the teammates. The
  in-game data lists alignments and spreads apart; each spread takes the alignments that make sense for it
  (no Jolly with nothing in Speed), balanced so that over all the spreads each alignment keeps its in-game
  share (Sneasler: 54% Jolly, so the Jollies are its 32-Speed spreads, not spread over all of them alike).
  Spreads past the top 10 are sampled from the top 10's own per-stat shares, each with an alignment that
  fits it, plus a few templates. Every legal ability stays possible (a share listed as 0.0% was still seen, just rarely),
  so unusual builds stay possible too. So does any item the game shows (a Rocky Helmet, Life Orb recoil, a berry), listed for that species or
  not, and any Mega it Mega Evolves into.
- Move sets are modelled as 4-move samples that reproduce the usage percentages, with item rules
  (Choice Scarf users don't run Protect), so seeing a move moves the item beliefs.
- Item Clause couples everyone's items exactly, across all six at team preview (brought or not): beside
  an Excadrill, which runs Focus Sash 85% of the time, a Sneasler almost never has one.
- A terrain seed follows its terrain's setter on the team. The usage shares mix teams with and without
  one, and how often a Pokémon's team has one comes from its usual teammates (the in-game list gives
  only their ranks; each rank's share is estimated from Showdown's stats). With a setter on the team a
  seed is as likely as among the teams that have one; without, next to never. Sneasler's Psychic Seed
  is 27% overall, 67% beside an Indeedee-F and about 1.5% with no Psychic Terrain setter.

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
- `src/data/icons.gen.json`: from `npm run data:icons`, each species' colours (normal and shiny) as team preview
  shows it, from Showdown's 3D renders (fetched once into `.cache/icons*`, about 13 MB).
- `src/data/moves.gen.json`, `abilities.gen.json`: from `@pkmn/dex` and `@smogon/calc` (`npm run data:tables`),
  including each move's priority: the calc keeps only positive ones, and turn order needs Trick Room's −7.
  Where the calc's Champions move differs from its Scarlet and Violet one, Champions' goes: Make It Rain lowers
  Sp. Atk by 2, Freeze-Dry can't freeze, Double Shock is a punch and Dragon Cheer a sound move. `npm run
  data:moves` rebuilds just the move table, from the installed packages (nothing downloaded).
- `@smogon/calc` 0.12's Champions data has 86 moves with no category. The 75 status moves among them are
  unaffected, but the 11 attacking ones have no type either, so the calc dealt 0 with them. Of those only
  Metal Claw is learnable in Champions (the other ten, Anchor Shot and the like, are in the calc's list
  though no Pokémon in Champions has them). `src/data/dex.ts` fills them in from the calc's gen 9 data.
- `@smogon/calc` 0.12 keeps the base power of moves that take it from the battle so far (it counts fainted allies
  only for Supreme Overlord). `src/engine/power.ts` works it out from the log, for the hits logged and the damage
  shown: Last Respects 50 more for each of its side fainted (on 6 Oct a Basculegion's, at 100 with its Grimmsnarl
  down, had been taken at 50: only a Life Orb could have made its KO, so a Choice Scarf was ruled out and its turn
  order came out impossible), Rage Fist 50 more for each hit taken (to 350), Stomping Tantrum and Temper Flare
  doubled after a move of its that failed or affected none the turn before (not one a Protect stopped: a
  Stomping Tantrum after Baneful Bunker did 75 power's damage), Avalanche and Revenge once the target has hurt it
  this turn, Round after its partner's.
- `public/data/leads-doubles.json`: from `npm run data:leads` (scripts/build-leads.mjs), the newest 3,000 public
  replays of Showdown's Champions VGC ladders (Reg M-C, best of one and best of three), fetched once into
  `.cache/replays` (about 25 MB, one request at a time). Each player's team counts once, however many games it
  played: a few players play many of the games (8 of the 2,071 were one side in eight), and their habits don't
  carry over to the next player. The build checks the model on players held out (five folds by player), picks the
  shrinkage that predicted them best, and prints how each setting did; the table carries that check, which the panel
  quotes. A Mega coming back in under its Mega name counts as the one in the six; formes no different in battle
  (Vivillon's patterns, Maushold-Four) count as their regular one, and Meowstic-F stays apart from Meowstic. The
  order of their six isn't used, though on Showdown it gives leads away (the first two led 11% of the time against
  7%, as teams are listed leads first): the game's order may not do the same.
- Official ladder data: live, not stored in this repo (through `/official/` on Cloudflare Pages).

## Known limitations

- Damage uses `@smogon/calc`'s Champions mechanics; unlogged modifiers (a partner's Friend Guard,
  Ruin abilities from partners) show up as flagged conflicts.
- Damage that isn't down to stats (Counter, Mirror Coat, Metal Burst, Comeuppance, Super Fang, Endeavor,
  one-hit KOs, Beat Up, Spit Up) is logged but learns nothing.
- Not tracked: accuracy and evasion stages, confusion and other volatile effects (Taunt, Encore,
  Substitute's doll, Leech Seed), Safeguard, Quick and Wide Guard, Fairy Lock, PP; Trick and Switcheroo's
  swap, a stolen item on the thief; moves that change abilities (Simple Beam, Skill Swap…). Power Trick, Power
  and Guard Split, Speed Swap and Transform aren't modelled: read off the screen, the Pokémon they change
  counts for nothing until it leaves the field. The per-item test lists the items with nothing to model and why.
- Quick Claw and Quick Draw count only when their chip is ticked (see *Turn order*); one left
  unticked reads as the Pokémon being faster (a Scarf, more Speed) or, where that can't be, as a
  flagged conflict.
- Illusion isn't modelled.
- Reading the game's screen is new (see *Reading the game's screen*): the reader is in development and test
  copies only, measured on BlueStacks at 1920×1080.

Credits: in-game Battle Data via championsbattledata.com (not affiliated with Nintendo, Game Freak or The
Pokémon Company), Smogon usage stats, `@smogon/calc`, `@pkmn/dex`, Showdown sprites, 3D renders and item icons, type
symbols recreated by [partywhale](https://github.com/partywhale/pokemon-type-icons) (MIT). Screen reading:
[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)'s PP-OCRv5 English recogniser (Apache 2.0), as converted to
ONNX in [monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx); [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
