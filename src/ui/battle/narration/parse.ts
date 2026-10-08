/**
 * Reads battle text into events: the game's own lines, worded as Pokémon Champions writes them
 * ("The opposing Salamence used Draco Meteor!", "A critical hit!", "It doesn't affect the opposing
 * Salamence...", "Charizard and Incineroar's Attack fell!", "Charizard fainted!", "The rain stopped.",
 * "Kim sent out Kingambit!", and the pop-ups: "Salamence's Intimidate"), plus HP where it's known
 * ("Charizard 45": yours in HP, theirs in %). Anything it can't place is skipped.
 */
import {allAbilities, allItems, allMoves, move as dexMove, toID, writtenName, type BoostID, type Gen} from '../../../data/dex';
import {megaFormeOf} from '../../../engine/likelihood';
import {moveFx} from '../../../engine/moves';
import type {MonSummary} from '../../../engine/worker';
import type {Battle, Boosts, MonRef, SideID, Status} from '../../../engine/types';
import {spokenName} from '../names';
import {fieldAt, statAt, type FieldNews, type SideNews} from './messages';
import {COMMON_WORDS, matchAt, norm, numberAt, similarity, squash, type Match, type MatchOptions, type Named} from './text';

export type NarrationEvent =
  | {kind: 'use'; actor: MonRef; move: string}
  /** "…used Dragon Claw on Charizard": who it was aimed at. */
  | {kind: 'target'; mon: MonRef}
  | {kind: 'hp'; mon?: MonRef; value: number}
  | {kind: 'faint'; mon?: MonRef}
  /** "A critical hit!"; in a spread move, "A critical hit on the opposing Kingambit!". */
  | {kind: 'crit'; mon?: MonRef}
  /** "It's super effective on the opposing Kingambit!" (spread moves): it was hit. */
  | {kind: 'effective'; mon: MonRef}
  /** It wasn't hit: "…avoided the attack!", "…'s attack missed!", or `shield`: "…protected itself!". */
  | {kind: 'miss'; mon?: MonRef; shield?: boolean}
  | {kind: 'immune'; mon?: MonRef}
  /** "But it failed!" */
  | {kind: 'fail'}
  /** "The Pokémon was hit 3 times!" */
  | {kind: 'hits'; n: number}
  | {kind: 'status'; mon?: MonRef; status: Status}
  /** Its turn came and it couldn't move: flinched, fully paralyzed, fast asleep, frozen, recharging… */
  | {kind: 'cant'; mon?: MonRef; status?: Status; flinch?: boolean}
  /** Its status ended: "…woke up!", "…'s Lum Berry cured its paralysis!". */
  | {kind: 'cure'; mon?: MonRef}
  /** "…'s Attack rose sharply!": how far each stat went. `limit`: "…won't go any higher!", so it's at ±6. */
  | {kind: 'stat'; mon?: MonRef; boosts: Boosts; limit?: boolean}
  /** "…'s Attack was not lowered!": what went to lower it (an Intimidate, a move) didn't. */
  | {kind: 'unchanged'; mon: MonRef; stats: BoostID[]}
  /** Weather, terrain, a room, or one side's Tailwind, screens or hazards starting, carrying on or ending. */
  | {kind: 'field'; news: FieldNews}
  /** End-of-turn damage or healing (sandstorm, burn, poison, Leftovers…): the turn's moves are over. */
  | {kind: 'residual'; mon?: MonRef; sand?: boolean; heal?: boolean}
  /**
   * Held by a binding move, seeded, salt cured: "…has been afflicted with an infestation by…!", "…was seeded!", "…is
   * being salt cured!" (the move being told reached it).
   */
  | {kind: 'trapped'; mon?: MonRef}
  /** "…was freed from Infestation!": the binding move let go, at the end of a turn. */
  | {kind: 'freed'; mon?: MonRef}
  /** "…must do an encore!" */
  | {kind: 'encored'; mon?: MonRef}
  /** A two-turn move's charge: "…absorbed electricity!" (Electro Shot), "…flew up high!" (Fly)… */
  | {kind: 'charge'; mon?: MonRef; move: string}
  /** "The battle has ended due to a forfeit.", "You lost to …!", "You defeated …!" */
  | {kind: 'battleEnd'}
  /** "…lost some of its HP!": Life Orb recoil. */
  | {kind: 'recoil'; mon?: MonRef}
  /** An item the game named. `gone`: it's gone now (popped, knocked off, eaten, flung…). */
  | {kind: 'item'; mon?: MonRef; item: string; gone?: boolean; taken?: boolean}
  | {kind: 'ability'; mon: MonRef; ability: string}
  | {kind: 'mega'; mon?: MonRef; suffix?: string}
  /** `voluntary`: "…, come back!", "… withdrew …!": switched out by choice, which happens before a turn's moves. */
  | {kind: 'withdraw'; mon?: MonRef; voluntary?: boolean}
  | {kind: 'sendOut'; mon: MonRef}
  /** "…was dragged out!" (Roar, Dragon Tail, Red Card): in for the one the move hit. */
  | {kind: 'dragged'; mon: MonRef}
  | {kind: 'endTurn'}
  /** "Rillaboom moved first", "… outsped Dragapult": where its move goes in the turn (before or after `other`). */
  | {kind: 'order'; mon: MonRef; place: 'first' | 'last'; other?: MonRef}
  /**
   * Its stat stages became `from`'s (Psych Up: "Milotic copied Baxcalibur's stat changes!", the one copied never called
   * "the opposing"), or `invert`ed (Topsy-Turvy: "All stat changes on … were inverted!").
   */
  | {kind: 'copyBoosts'; mon: MonRef; from: MonRef; invert?: boolean}
  /**
   * Its move this turn comes where something else put it, not where its Speed does: After You ("…took the kind
   * offer!"), Quash ("…'s move was postponed!"), Instruct ("…followed …'s instructions!": `again`, its move once more).
   */
  | {kind: 'outOfTurn'; mon: MonRef; again?: boolean}
  /**
   * Its types changed: to `to` (Protean, Libero, Soak: "…transformed into the Water type!"; Reflect Type: `like`, "…became
   * the same type as …!"), with `add` (Trick-or-Treat, Forest's Curse: "Ghost type was added to …!"), without `lose`
   * (Burn Up: "…burned itself out!", Double Shock: "…used up all its electricity!"), or back to its own (`back`).
   */
  | {kind: 'types'; mon: MonRef; to?: string; like?: MonRef; add?: string; lose?: string; back?: boolean}
  /**
   * Changed in a way the app doesn't follow (Transform, Imposter, Power Trick, a swap or split of stats with a target it
   * can't tell…): what it deals and takes, and when it moves, say nothing of its set until it leaves the field.
   */
  | {kind: 'odd'; mon: MonRef}
  /** Ally Switch: "Charizard and Incineroar switched places!" */
  | {kind: 'places'; side: SideID}
  /** Its HP box is up in that place (read off the screen, not the text): it's out there. */
  | {kind: 'onField'; mon: MonRef; position: number};

export interface ParseEnv {
  battle: Battle;
  gen: Gen;
  mons: (MonSummary | null)[] | undefined;
}

type Phrase = 'crit' | 'faint' | 'miss' | 'missAfter' | 'shield' | 'immune' | 'immuneAfter' | 'recoil' | 'status' | 'sendOut'
  | 'lead' | 'go' | 'withdraw' | 'withdrawAfter' | 'mega' | 'endTurn' | 'first' | 'last' | 'effective' | 'fail' | 'hits' | 'cant'
  | 'cure' | 'encored' | 'charge' | 'battleEnd' | 'residual' | 'knockOff' | 'steal' | 'itemGone' | 'seen' | 'whiteHerb' | 'popped' | 'obtained' | 'dragged' | 'reacting'
  | 'substitute' | 'blewAway' | 'quickDraw' | 'maxAttack' | 'unaffected' | 'unaffectedBy' | 'targetsItem' | 'skip' | 'skipMove'
  | 'skipCount' | 'copied' | 'offer' | 'postponed' | 'followed' | 'transformedInto' | 'typeAdded' | 'sameType' | 'burnedOut'
  | 'noElectricity' | 'typeBack' | 'inverted' | 'oddChange' | 'places' | 'trapped' | 'freed';

/**
 * Pokémon Champions' battle lines (its own English text: see messages.ts) after norm(), longest
 * first so "critical hit" wins over "critical"; and a few things said rather than read ("end turn",
 * "Rillaboom moved first"). `extra`: the status, "sand", or "voluntary" (a switch made at the start
 * of a turn, not in the middle of one).
 */
const PHRASES: [string[], Phrase, string?][] = ([
  // The hit.
  ['critical hit', 'crit'], ['critical', 'crit'], ['crit', 'crit'],
  ['extremely effective', 'effective'], ['super effective', 'effective'], ['not very effective', 'effective'],
  ['mostly ineffective', 'effective'],
  ['fainted', 'faint'], ['faints', 'faint'], ['knocked out', 'faint'], ['ko', 'faint'], ['k o', 'faint'],
  ['a one hit ko', 'skip'], ['one hit ko', 'skip'],
  ['protected itself', 'shield'], ['protected', 'shield'],
  // Hurt through its protection ("It broke through …'s protection!"): not a miss.
  ['couldnt fully protect itself', 'skip'], ['broke through', 'skip'],
  ['avoided the attack', 'miss'], ['avoided', 'miss'], ['missed', 'miss'], ['miss', 'miss'],
  ['the substitute took damage for', 'substitute'], ['substitute took damage for', 'substitute'],
  // "It doesn't affect the opposing Salamence…" names it after; "…is unaffected!" before.
  ['doesnt affect', 'immuneAfter'], ['does not affect', 'immuneAfter'], ['didnt affect', 'immuneAfter'],
  ['no effect', 'immune'], ['unaffected', 'immune'], ['immune', 'immune'],
  ['but it failed to affect', 'missAfter'], ['failed to affect', 'missAfter'],
  // It didn't take: "…cannot be poisoned!", "…is already asleep!", "…stays awake!"; "…is not affected by Spore thanks to its Safety Goggles!".
  ['cannot be poisoned', 'unaffected'], ['cannot be burned', 'unaffected'], ['cannot be paralyzed', 'unaffected'],
  ['cannot be frozen solid', 'unaffected'], ['is already poisoned', 'unaffected'], ['is already burned', 'unaffected'],
  ['is already paralyzed', 'unaffected'], ['is already asleep', 'unaffected'], ['stays awake', 'unaffected'],
  ['stays wide awake', 'unaffected'], ['stayed awake', 'unaffected'], ['is not affected by', 'unaffectedBy'],
  // Lines that only look like something: Magnet Rise, Electrify, Safeguard ending, Perish Song, Fairy Lock, Forewarn.
  ['levitated with electromagnetism', 'skip'], ['electromagnetism wore off', 'skip'],
  ['moves have been electrified', 'skip'], ['no longer protected', 'skip'], ['will faint in three turns', 'skip'],
  ['during the next turn', 'skip'], ['one of the moves', 'skip'], ['already has a substitute', 'skip'], ['stockpiled', 'skipCount'],
  // Encore taking hold (its move is logged from "…used Encore!"), and the battle over.
  ['must do an encore', 'encored'], ['has ended due to', 'battleEnd'], ['you lost to', 'battleEnd'], ['you defeated', 'battleEnd'],
  // A two-turn move's charge, and which move it is.
  ['absorbed electricity', 'charge', 'Electro Shot'], ['overflowing with space power', 'charge', 'Meteor Beam'],
  ['absorbed light', 'charge', 'Solar Beam'], ['burrowed its way under the ground', 'charge', 'Dig'], ['flew up high', 'charge', 'Fly'],
  ['hid underwater', 'charge', 'Dive'], ['vanished instantly', 'charge', 'Phantom Force'], ['sprang up', 'charge', 'Bounce'],
  ['became cloaked in a harsh light', 'charge', 'Sky Attack'],
  ['won the battle', 'battleEnd'], ['battled to a draw', 'battleEnd'], ['time has run out', 'battleEnd'],
  ['but it failed', 'fail'], ['it failed', 'fail'], ['does not have enough hp', 'fail'], ['but nothing happened', 'fail'],
  ['pokemon was hit', 'hits'], ['was hit', 'hits'],
  ['lost some of its hp', 'recoil'], ['lost some hp', 'recoil'], ['lost some', 'recoil'],
  // Statuses: given, keeping it from moving, ending.
  ['badly poisoned by the toxic orb', 'residual', 'tox'], ['burned by the flame orb', 'residual', 'brn'],
  ['badly poisoned', 'status', 'tox'], ['poisoned', 'status', 'psn'], ['burned', 'status', 'brn'],
  ['paralyzed', 'status', 'par'], ['fell asleep', 'status', 'slp'], ['was frozen solid', 'status', 'frz'], ['frozen', 'status', 'frz'],
  ['couldnt move because its paralyzed', 'cant', 'par'], ['is fast asleep', 'cant', 'slp'], ['fast asleep', 'cant', 'slp'],
  ['is frozen solid', 'cant', 'frz'],
  ['flinched and couldnt move', 'cant', 'flinch'], ['flinched', 'cant', 'flinch'], ['must recharge', 'cant'], ['lost its focus and couldnt move', 'cant'],
  ['lost its focus', 'cant'], ['hurt itself in its confusion', 'cant'], ['immobilized by love', 'cant'], ['cant use', 'cant'],
  ['cannot use', 'cant'], ['couldnt move', 'cant'], ['cant move', 'cant'], ['cannot move', 'cant'],
  ['woke up', 'cure'], ['woke it up', 'cure'], ['snap fully awake', 'cure'], ['thawed out', 'cure'], ['defrosted it', 'cure'],
  ['was cured of', 'cure'], ['cured its', 'cure'], ['burn was cured', 'cure'], ['status returned to normal', 'cure'],
  // "…'s Matcha Gotcha melted the ice!": a frozen one's move thawing it.
  ['melted the ice', 'cure', 'thaw'],
  // Binding moves, Leech Seed, Salt Cure taking hold; a binding move letting go.
  ['has been afflicted with an infestation', 'trapped'], ['became trapped in the fiery vortex', 'trapped'],
  ['became trapped in the vortex', 'trapped'], ['became trapped by the quicksand', 'trapped'], ['was wrapped by', 'trapped'],
  ['was squeezed by', 'trapped'], ['got trapped by a snap trap', 'trapped'], ['was seeded', 'trapped'],
  ['is being salt cured', 'trapped'], ['was freed from', 'freed'],
  // The end of the turn.
  ['buffeted by the sandstorm', 'residual', 'sand'], ['hurt by its burn', 'residual'], ['hurt by its poisoning', 'residual'],
  ['sapped by leech seed', 'residual'], ['is hurt by', 'residual'], ['afflicted by the curse', 'residual'],
  ['perish count fell to', 'residual'],
  // Grassy Terrain, Leftovers (a Sitrus Berry too, mid-move: see the narrator).
  ['had its hp restored', 'residual', 'heal'],
  // Items coming and going.
  ['knocked off', 'knockOff'], ['corroded', 'knockOff'], ['stole and ate its targets', 'targetsItem'], ['stole', 'steal'],
  ['flung its', 'itemGone'],
  // Quick Claw going off ("…can act faster than normal, thanks to its Quick Claw!"): not the turn order said.
  ['can act faster than normal thanks to its', 'seen'],
  // Frisk ("…found its Leftovers!", "…was frisked, revealing its Leftovers!"), Poltergeist: still held.
  ['found its', 'seen'], ['revealing its', 'seen'], ['attacked by its', 'seen'],
  ['returned its stats to normal using its', 'whiteHerb'],
  ['popped', 'popped'], ['obtained', 'obtained'], ['is reacting to', 'reacting'], ['reacting to', 'reacting'],
  // "…blew away Stealth Rock!", "Quick Draw made … move faster!", "…maxed its Attack!" (Anger Point).
  ['blew away', 'blewAway'], ['quick draw made', 'quickDraw'], ['maxed its attack', 'maxAttack'],
  // "…took the Future Sight attack!", "…took the attack!" (Lightning Rod): no move used.
  ['took the', 'skipMove'],
  // Stat stages copied (Psych Up) or inverted (Topsy-Turvy).
  ['copied', 'copied'], ['were inverted', 'inverted'],
  // A move made out of its Speed's turn: After You, Quash, Instruct.
  ['took the kind offer', 'offer'], ['move was postponed', 'postponed'], ['followed', 'followed'], ['switched places', 'places'],
  // Types changed: Protean, Libero, Soak ("…transformed into the Water type!"), Trick-or-Treat, Reflect Type, Burn Up,
  // Double Shock. Transform and Imposter ("…transformed into Incineroar!") and the rest the app doesn't follow: odd.
  ['transformed into', 'transformedInto'], ['type was added to', 'typeAdded'], ['became the same type as', 'sameType'],
  ['burned itself out', 'burnedOut'], ['used up all its electricity', 'noElectricity'], ['returned to its original type', 'typeBack'],
  ['transformed', 'oddChange'], ['switched its attack and defense', 'oddChange'], ['switched all changes to its', 'oddChange'],
  ['switched speed with its target', 'oddChange'], ['shared its power with the target', 'oddChange'],
  ['shared its guard with the target', 'oddChange'], ['underwent a heroic transformation', 'oddChange'],
  // Switching. "…, come back!" and "… withdrew …!" are the switches chosen for a turn, made before its moves.
  ['sent out', 'sendOut'], ['send out', 'sendOut'], ['sends out', 'sendOut'], ['brought out', 'sendOut'], ['brings out', 'sendOut'],
  // Said rather than read: "opponent sent Rillaboom and Corviknight", "I lead with Dragapult".
  ['sent', 'sendOut'], ['sends', 'sendOut'], ['sending', 'sendOut'],
  ['leads with', 'lead'], ['lead with', 'lead'], ['leading with', 'lead'], ['starts with', 'lead'], ['opens with', 'lead'],
  ['leads', 'lead'], ['leading', 'lead'], ['lead', 'lead'],
  ['go for it', 'go'], ['youre in charge', 'go'], ['go', 'go'],
  ['come back', 'withdraw', 'voluntary'], ['went back', 'withdraw'], ['switched out', 'withdraw'],
  ['withdrew', 'withdrawAfter', 'voluntary'],
  ['was dragged out', 'dragged'], ['dragged out', 'dragged'],
  ['mega evolved', 'mega'], ['mega evolves', 'mega'], ['mega evolution', 'mega'], ['mega evolve', 'mega'],
  // Said rather than read: "Lopunny mega", "mega Lopunny".
  ['mega', 'mega'],
  // Champions has no line between turns: said ("end turn", "next turn"), or worked out (see the narrator).
  ['end turn', 'endTurn'], ['end of turn', 'endTurn'], ['next turn', 'endTurn'], ['new turn', 'endTurn'], ['turn over', 'endTurn'],
  // Turn order, said after the fact: "Rillaboom moved first", "Kingambit outsped Dragapult", "Gholdengo went last".
  ['moved first', 'first'], ['went first', 'first'], ['goes first', 'first'], ['moves first', 'first'], ['was first', 'first'],
  ['attacked first', 'first'], ['moved before', 'first'], ['went before', 'first'], ['outsped', 'first'], ['outspeeds', 'first'],
  ['out sped', 'first'], ['was faster than', 'first'], ['is faster than', 'first'], ['faster than', 'first'], ['was faster', 'first'],
  ['moved last', 'last'], ['went last', 'last'], ['goes last', 'last'], ['moves last', 'last'], ['was last', 'last'],
  ['moved after', 'last'], ['went after', 'last'], ['got outsped by', 'last'], ['was outsped by', 'last'], ['got outsped', 'last'],
  ['was outsped', 'last'], ['was slower than', 'last'], ['is slower than', 'last'], ['slower than', 'last'], ['was slower', 'last'],
] as [string, Phrase, string?][])
  .map(([p, kind, extra]) => [p.split(' '), kind, extra] as [string[], Phrase, string?])
  .sort((a, b) => b[0].length - a[0].length);

const OPPOSING = new Set(['opposing', 'opponent', 'opponents', 'foe', 'foes', 'enemy', 'their', 'theirs', 'they', 'rival', 'wild']);
const MINE = new Set(['i', 'im', 'ill', 'my', 'me', 'mine', 'we', 'our', 'ours']);
/**
 * Pokémon are matched only among the dozen in the battle, so badly heard names can be let through
 * ("carbonite" for Corviknight, "really boom" for Rillaboom), with common words kept out.
 */
const NAMES: MatchOptions = {consonants: true, stop: COMMON_WORDS, prefix: true};
const USED = new Set(['used', 'uses', 'use', 'using']);
const BEFORE_HP = new Set(['at', 'to', 'down', 'is', 'has', 'now', 'on', 'with', 'left', 'hp', 'health']);
const AFTER_HP = new Set(['percent', 'hp', 'left']);

/** Mega Kick, Mega Punch, Mega Drain and Mega Launcher: a move or ability, not "mega" said for Mega Evolution. */
const NOT_MEGA = new Set(['kick', 'punch', 'drain', 'launcher']);

function phraseAt(words: string[], i: number): {kind: Phrase; len: number; extra?: string} | null {
  for (const [p, kind, extra] of PHRASES) {
    if (!p.every((w, k) => words[i + k] === w)) continue;
    if (kind === 'mega' && p.length === 1 && NOT_MEGA.has(words[i + 1] ?? '')) continue;
    return {kind, len: p.length, extra};
  }
  return null;
}

/** "…'s Charizardite Y is reacting to Roman's Omni Ring!": what the trainer's name is followed by. */
const MEGA_GEAR = new Set(['ring', 'bracelet', 'stone', 'band', 'key']);
/** "…blew away Stealth Rock!": the hazards, by the moves' names. */
const HAZARDS: [string[], SideNews][] = [
  [['stealth', 'rock'], 'stealthRock'], [['toxic', 'spikes'], 'toxicSpikes'], [['sticky', 'web'], 'stickyWeb'], [['spikes'], 'spikes'],
];
/** The types, by the word for them ("…transformed into the Water type!"). */
const TYPES = new Map(['Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'].map(t => [t.toLowerCase(), t]));
/** "Wide Guard protected the opposing team!" */
const TEAM_WORDS = new Set(['team', 'teams', 'side']);
const TARGET_WORDS = new Set(['on', 'at', 'into', 'against']);
const NOT_HP_AFTER = new Set(['pp', 'times', 'time', 'turns', 'turn', 'of', 'layers', 'layer', 'stages', 'stage']);

const refOf = (key: string): MonRef => (key.startsWith('me')
  ? {side: 'me', slot: Number(key.slice(2))}
  : {side: 'opp', slot: Number(key.slice(3))});

const REGION: Record<string, [string, string]> = {
  Alola: ['alolan', 'alola'], Galar: ['galarian', 'galar'], Hisui: ['hisuian', 'hisui'], Paldea: ['paldean', 'paldea'],
};
const GENDER: Record<string, string[]> = {F: ['female'], M: ['male']};

/** The ways a preview name can be written: "Ninetales-Alola" is "Alolan Ninetales" or "Ninetales Alola". */
function spokenNames(name: string): string[] {
  const [base, ...rest] = name.split('-');
  // "Kommo-o": the dash is part of the name.
  if (!rest.length || rest.every(r => r.length === 1 && !GENDER[r])) return [name];
  const words = rest.map(r => REGION[r] ?? GENDER[r] ?? [r.toLowerCase()]);
  // Nobody writes "Basculegion F" (a letter off plain Basculegion); "Ninetales Alola", yes.
  const out = new Set(rest.some(r => GENDER[r]) ? [] : [name]);
  out.add(`${words.map(w => w[0]).join(' ')} ${base}`);
  out.add(`${base} ${words.map(w => w[w.length - 1]).join(' ')}`);
  // "Aqua Tauros" for Tauros-Paldea-Aqua: the last part alone, either side.
  const last = words[words.length - 1];
  for (const w of last) {
    out.add(`${w} ${base}`);
    out.add(`${base} ${w}`);
  }
  return [...out];
}

/** Every Pokémon on a side, by the names narration may use: species, nickname, base species, "Mega X". */
function monNames(env: ParseEnv, side: SideID): (Named<string> & {said: string})[] {
  const out: (Named<string> & {said: string})[] = [];
  const active = env.battle.live.active[side];
  const add = (slot: number, name: string | undefined) => {
    for (const said of name ? spokenNames(name) : []) out.push({key: squash(said), value: `${side}${slot}`, bonus: active.includes(slot) ? 0.04 : 0, said});
  };
  if (side === 'me') {
    env.battle.myTeam.forEach((set, slot) => {
      add(slot, set.species);
      add(slot, set.nickname);
      add(slot, env.gen.species.get(toID(set.species))?.baseSpecies);
      add(slot, writtenName(env.gen, set.species));
      const mega = megaFormeOf(env.gen, set);
      if (mega) add(slot, spokenName(mega));
    });
  } else {
    env.battle.oppPreview.forEach((species, slot) => {
      add(slot, species);
      add(slot, env.gen.species.get(toID(species))?.baseSpecies);
      // As the game writes it: "Floette" for Floette-Eternal (no base species in the calc's data).
      add(slot, writtenName(env.gen, species));
      for (const f of env.mons?.[slot]?.formes ?? []) if (f.p > 0 && /-Mega/.test(f.name)) add(slot, spokenName(f.name));
    });
  }
  return out;
}

const listCache = new WeakMap<Gen, Record<string, Named<string>[]>>();
function every(gen: Gen, what: 'moves' | 'items' | 'abilities'): Named<string>[] {
  let c = listCache.get(gen);
  if (!c) listCache.set(gen, (c = {}));
  if (!c[what]) {
    const names = what === 'moves' ? allMoves(gen) : what === 'items' ? allItems(gen) : allAbilities(gen);
    c[what] = names.map(n => ({key: squash(n), value: n}));
  }
  return c[what];
}

/** The words the game's lines are made of (the phrases', and common ones). */
let lineWords: ReadonlySet<string> | undefined;
const isLineWord = (w: string) => (lineWords ??= new Set([...PHRASES.flatMap(([p]) => p), ...HAZARDS.flatMap(([p]) => p), ...COMMON_WORDS])).has(w);
/** Words that follow a name, run into it by the reader: a trainer's ("tenkiwithdrew Whimsicott!"). */
const AFTER_A_NAME = ['withdrew', 'used', 'fainted'];

const nameCache = new WeakMap<Gen, Set<string>>();
/** A species', move's, item's or ability's name, run together (never taken apart). */
function isName(gen: Gen, w: string): boolean {
  let names = nameCache.get(gen);
  if (!names) {
    names = new Set([...every(gen, 'moves'), ...every(gen, 'items'), ...every(gen, 'abilities')].map(n => n.key));
    for (const sp of gen.species) names.add(squash(sp.name));
    nameCache.set(gen, names);
  }
  return names.has(squash(w));
}

/** The fewest words of the game's lines (two letters at least) this is made of, if it's made of nothing else. */
function lineWordsIn(w: string): string[] | null {
  const best: (string[] | null)[] = [[]];
  for (let end = 1; end <= w.length; end++) {
    best[end] = null;
    for (let start = Math.max(0, end - 16); start <= end - 2; start++) {
      const before = best[start];
      if (before && isLineWord(w.slice(start, end)) && (!best[end] || before.length + 1 < best[end]!.length)) {
        best[end] = [...before, w.slice(start, end)];
      }
    }
  }
  const parts = best[w.length];
  return parts && parts.length > 1 ? parts : null;
}

/**
 * Words the reader ran together, taken apart: "Butit failed!", "…had its HPrestored." (6 Oct: neither was taken in), a
 * trainer's name run into "withdrew". Only into words the game's lines use: a name stays whole (Moonblast, Overheat).
 */
function unmerged(gen: Gen, words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const parts = w.length < 4 || isLineWord(w) || isName(gen, w) ? null : lineWordsIn(w);
    const tail = parts ? undefined : AFTER_A_NAME.find(t => w.length >= t.length + 2 && w.endsWith(t) && !isName(gen, w));
    if (parts) out.push(...parts);
    else if (tail) out.push(w.slice(0, -tail.length), tail);
    else out.push(w);
  }
  return out;
}

export function parseNarration(text: string, env: ParseEnv): NarrationEvent[] {
  const words = unmerged(env.gen, norm(text).split(' ').filter(Boolean));
  /** Read before it was all written: no full stop or mark at its end (its last word may be cut short). */
  const cut = !/[.!?…]["”']?$/.test(text.trim());
  const names = {me: monNames(env, 'me'), opp: monNames(env, 'opp')};
  const out: NarrationEvent[] = [];
  let last: MonRef | undefined;
  /** Where the words naming `last` ended: a line straight after is about it ("Salamence, come back!"). */
  let lastEnd = -1;
  /** The word being read. */
  let i = 0;
  /** Whose Pokémon the words so far are about ("opponent…", "I…"): settles a species both sides have. */
  let ctx: SideID | undefined;
  const live = env.battle.live;
  /** Places free on each side (empty, or its Pokémon fainted): a benched Pokémon named there has come in. */
  const room: Record<SideID, number> = {me: 0, opp: 0};
  for (const side of ['me', 'opp'] as const) {
    room[side] = live.active[side].filter(s => s === null || (live.mons[`${side}${s}`]?.hp ?? 1) <= 0).length;
  }
  const benched = (ref: MonRef) => !live.active[ref.side].includes(ref.slot) && (live.mons[`${ref.side}${ref.slot}`]?.hp ?? 1) > 0;
  const nameAt = (at: number, side: SideID) => {
    const m = matchAt(words, at, names[side], 0.6, 0.12, NAMES);
    // A name doesn't run over the words of a line ("c.c. withdrew Avalugg!" read as one long Avalugg).
    for (let k = at + 1; m && k < at + m.len; k++) if (phraseAt(words, k) || USED.has(words[k])) return null;
    return m;
  };
  const same = (a: MonRef, b: MonRef) => a.side === b.side && a.slot === b.slot;
  /** A Pokémon was named: the lines after are about it. */
  /** The first named in the line: whose a possessive line is ("…'s Matcha Gotcha melted the ice!"). */
  let first: MonRef | undefined;
  const named = (ref: MonRef, end: number) => {
    [last, lastEnd, i] = [ref, end, end];
    first ??= ref;
  };

  /**
   * A Pokémon named at i. The game calls theirs "the opposing X"; without that, a species both
   * sides have is the one of the side being talked about, else yours.
   */
  const monAt = (i: number, prefer?: SideID): {ref: MonRef; len: number; possessive?: boolean} | null => {
    const opposing = OPPOSING.has(words[i - 1] ?? '') || (words[i - 1] === 'the' && OPPOSING.has(words[i - 2] ?? ''));
    const mine = opposing ? null : nameAt(i, 'me');
    const theirs = nameAt(i, 'opp');
    const side = prefer ?? ctx;
    const m = mine && theirs
      ? (mine.score > theirs.score || (mine.score === theirs.score && side !== 'opp') ? mine : theirs)
      : mine ?? theirs;
    return m ? {ref: refOf(m.value), len: m.len, possessive: m.possessive} : null;
  };
  const nextMon = (from: number, span: number, prefer?: SideID) => {
    for (let j = from; j < Math.min(words.length, from + span); j++) {
      const m = monAt(j, prefer);
      if (m) return {...m, at: j};
    }
    return null;
  };
  /** One side's Pokémon only: the game says "Go! X!" for yours and "…sent out X!" for theirs, whatever else is on the field. */
  const sideAt = (at: number, side: SideID) => {
    const m = nameAt(at, side);
    return m ? {ref: refOf(m.value), len: m.len, at} : null;
  };
  const nextOnSide = (from: number, span: number, side: SideID) => {
    for (let j = from; j < Math.min(words.length, from + span); j++) {
      const m = sideAt(j, side);
      if (m) return m;
    }
    return null;
  };
  /** Doubles sends out two at once: "…sent out Salamence and Rillaboom!", "Go! Incineroar and Sneasler!". */
  const sentOut = (m: {ref: MonRef; len: number; at: number}) => {
    out.push({kind: 'sendOut', mon: m.ref});
    room[m.ref.side] = Math.max(0, room[m.ref.side] - 1);
    named(m.ref, m.at + m.len);
    const second = words[i] === 'and' ? sideAt(i + 1, m.ref.side) : null;
    if (second) {
      out.push({kind: 'sendOut', mon: second.ref});
      room[second.ref.side] = Math.max(0, room[second.ref.side] - 1);
      named(second.ref, second.at + second.len);
    }
  };
  /**
   * The line cut off in a move's name ("The opposing Aromatisse used Moonbla", 5 Oct: Moonblast went unlogged and its
   * damage to Heat Wave): the one of these it's the start of, four letters at least.
   */
  const cutShort = (i: number, cands: Named<string>[]): Match<string> | null => {
    const start = squash(words.slice(i).join(''));
    if (!cut || start.length < 4) return null;
    const fits = cands.filter(c => c.key.startsWith(start) && c.key !== start);
    return fits.length === 1 ? {value: fits[0].value, len: words.length - i, score: 0.75} : null;
  };
  const moveAt = (i: number, ref: MonRef) => {
    if (ref.side === 'me') {
      const own = (env.battle.myTeam[ref.slot]?.moves ?? []).map(m => ({key: squash(m), value: m}));
      return matchAt(words, i, own, 0.66, 0.06) ?? cutShort(i, own);
    }
    const likely = (env.mons?.[ref.slot]?.moves ?? []).filter(m => m.p > 0).map(m => ({key: squash(m.name), value: m.name}));
    return matchAt(words, i, likely, 0.7, 0.06) ?? matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03)
      ?? cutShort(i, likely) ?? cutShort(i, every(env.gen, 'moves'));
  };
  /** The words at `at` spell the name matched (not just sound like it: "has" and Haze). */
  const spelled = (at: number, m: Match<string>) => similarity(squash(words.slice(at, at + m.len).join('')), squash(m.value)) >= 0.95;
  const abilityAt = (i: number, ref: MonRef) => {
    const m = ref.side === 'opp' ? env.mons?.[ref.slot] : undefined;
    const own = ref.side === 'me' ? [env.battle.myTeam[ref.slot]?.ability] : [
      ...(m?.abilities ?? []).filter(a => a.p > 0).map(a => a.name), ...Object.values(m?.megaAbilityOf ?? {}),
    ];
    const cands = own.filter((a): a is string => !!a).map(a => ({key: squash(a), value: a}));
    return matchAt(words, i, cands, 0.75, 0.06) ?? matchAt(words, i, every(env.gen, 'abilities'), 0.86, 0.03);
  };
  const itemAt = (i: number, ref: MonRef) => {
    const own = ref.side === 'me' ? [env.battle.myTeam[ref.slot]?.item]
      : (env.mons?.[ref.slot]?.items ?? []).filter(x => x.p > 0).map(x => x.name);
    const cands = own.filter((x): x is string => !!x).map(x => ({key: squash(x), value: x}));
    const likely = matchAt(words, i, cands, 0.75, 0.06);
    const any = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
    // One spelled out in full beats a likely one it starts with: "Garchompite Z", not Garchompite and a stray "z".
    return any && likely && any.len > likely.len && spelled(i, any) ? any : likely ?? any;
  };
  /**
   * "The opposing Salamence's Intimidate", "Rillaboom's Sitrus Berry": its ability or item, whichever
   * fits better (the longer when both do: "Damp Rock" over Damp).
   */
  const abilityOrItemAt = (i: number, ref: MonRef): {event: NarrationEvent; len: number} | null => {
    const ab = abilityAt(i, ref);
    const it = itemAt(i, ref);
    if (it && (!ab || it.score > ab.score || (it.score === ab.score && it.len > ab.len))) {
      return {event: {kind: 'item', mon: ref, item: it.value}, len: it.len};
    }
    return ab ? {event: {kind: 'ability', mon: ref, ability: ab.value}, len: ab.len} : null;
  };
  const statEvent = (mon: MonRef, st: {boosts: Boosts; limit?: boolean; unchanged?: BoostID[]}) => {
    if (Object.keys(st.boosts).length) out.push({kind: 'stat', mon, boosts: st.boosts, limit: st.limit});
    // "…was not lowered!": an ability or item stopped it. ("…'s accuracy fell!" isn't tracked: read past.)
    else if (st.unchanged) out.push({kind: 'unchanged', mon, stats: st.unchanged});
  };
  /**
   * The side a move is aimed at when it's chosen against one Pokémon (not spread moves, not its
   * user's own): a foe, or its ally for Helping Hand and the like.
   */
  const aimedSide = (move: string, actor: MonRef): SideID | null => {
    const t = moveFx(move).tg ?? dexMove(env.gen, move)?.target ?? 'normal';
    if (t === 'adjacentAlly') return actor.side;
    return t === 'normal' || t === 'any' || t === 'adjacentFoe' ? (actor.side === 'me' ? 'opp' : 'me') : null;
  };
  /** A move of this Pokémon's at `at`: "…Bellibolt used Thunderbolt", "…Bellibolt Thunderbolt". */
  const movesAt = (at: number, ref: MonRef) => {
    if (USED.has(words[at] ?? '')) return true;
    const m = moveAt(at, ref);
    return !!m && m.score >= 0.9 && spelled(at, m);
  };

  while (i < words.length) {
    if (OPPOSING.has(words[i])) ctx = 'opp';
    else if (MINE.has(words[i])) ctx = 'me';
    const field = fieldAt(words, i);
    if (field) {
      out.push({kind: 'field', news: field.news});
      i += field.len;
      continue;
    }
    const ph = phraseAt(words, i);
    if (ph) {
      /** Straight after a name: the line is about that Pokémon. */
      const afterName = lastEnd === i;
      const start = i;
      i += ph.len;
      switch (ph.kind) {
        case 'crit':
        case 'effective': {
          // "A critical hit on the opposing Kingambit!", "It's super effective on the opposing Kingambit and Salamence!"
          const m = words[i] === 'on' ? nextMon(i + 1, 3) : null;
          if (m) named(m.ref, m.at + m.len);
          if (ph.kind === 'crit') out.push({kind: 'crit', mon: m?.ref});
          else if (m) {
            out.push({kind: 'effective', mon: m.ref});
            const also = words[i] === 'and' || words[i] === 'or' ? nextMon(i + 1, 3) : null;
            if (also) {
              out.push({kind: 'effective', mon: also.ref});
              named(also.ref, also.at + also.len);
            }
          }
          break;
        }
        case 'faint':
          out.push({kind: 'faint', mon: last});
          break;
        case 'miss':
          out.push({kind: 'miss', mon: last});
          break;
        case 'shield': {
          // "…protected itself!", "…is protected by the Psychic Terrain!", "Wide Guard protected the opposing Rillaboom!"
          if (ph.len > 1 || words[i] === 'by') {
            if (last) out.push({kind: 'miss', mon: last, shield: true});
            break;
          }
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref, shield: true});
          } else if (!words.slice(i, i + 3).some(w => TEAM_WORDS.has(w))) out.push({kind: 'miss', mon: last, shield: true});
          break;
        }
        case 'unaffected':
          if (last) out.push({kind: 'miss', mon: last});
          break;
        case 'unaffectedBy': {
          // "…is not affected by Spore thanks to its Safety Goggles!": the item comes after.
          if (last) out.push({kind: 'immune', mon: last});
          const mv = matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03);
          if (mv) i += mv.len;
          break;
        }
        case 'targetsItem': {
          // Bug Bite, Pluck: the berry of whoever it hit, eaten.
          const it = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
          if (it) {
            out.push({kind: 'item', item: it.value, gone: true, taken: true});
            i += it.len;
          }
          break;
        }
        case 'missAfter': {
          // "But it failed to affect the opposing Garchomp!"
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref});
          }
          break;
        }
        case 'substitute': {
          // "The substitute took damage for the opposing Garchomp!": its HP didn't change.
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'miss', mon: m.ref});
          }
          break;
        }
        case 'recoil':
          out.push({kind: 'recoil', mon: last});
          break;
        case 'status': {
          // "…is paralyzed! It can't move!" is its turn lost; "…is paralyzed, so it may be unable to move!" is the status.
          const k = ph.extra === 'par' ? words.slice(i, i + 3).findIndex(w => w === 'cant' || w === 'couldnt' || w === 'cannot') : -1;
          if (k >= 0) {
            i += k + 1;
            if (words[i] === 'move') i++;
            out.push({kind: 'cant', mon: last, status: 'par'});
          } else out.push({kind: 'status', mon: last, status: ph.extra as Status});
          break;
        }
        case 'cant':
          out.push(ph.extra === 'flinch' ? {kind: 'cant', mon: last, flinch: true} : {kind: 'cant', mon: last, status: ph.extra as Status | undefined});
          break;
        case 'cure':
          // "The opposing Sinistcha's Matcha Gotcha melted the ice!": Sinistcha's, whatever its move's name sounds like.
          out.push({kind: 'cure', mon: ph.extra === 'thaw' ? first ?? last : last});
          break;
        case 'encored':
          out.push({kind: 'encored', mon: last});
          break;
        case 'trapped':
          out.push({kind: 'trapped', mon: last});
          // "…by Toxapex!", "…by the opposing Arbok!": the binder, the one telling its move.
          i = words.length;
          break;
        case 'freed':
          out.push({kind: 'freed', mon: last});
          // "…from Infestation!"
          i = words.length;
          break;
        case 'charge':
          out.push({kind: 'charge', mon: last, move: ph.extra!});
          break;
        case 'battleEnd':
          out.push({kind: 'battleEnd'});
          i = words.length;
          break;
        case 'residual': {
          out.push({kind: 'residual', mon: last, sand: ph.extra === 'sand' || undefined, heal: ph.extra === 'heal' || undefined});
          if (ph.extra && ph.extra !== 'sand' && ph.extra !== 'heal') out.push({kind: 'status', mon: last, status: ph.extra as Status});
          // "…'s perish count fell to 2!", "…is hurt by Fire Spin!"
          const n = words[start] === 'perish' ? numberAt(words, i) : null;
          if (n) i += n.len;
          const by = words[start] === 'is' ? matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03) : null;
          if (by) i += by.len;
          break;
        }
        case 'fail':
          out.push({kind: 'fail'});
          break;
        case 'hits': {
          // "The Pokémon was hit 3 times!"
          const n = numberAt(words, i);
          if (n && n.value >= 1 && n.value <= 10) {
            out.push({kind: 'hits', n: n.value});
            i += n.len;
            if (words[i] === 'times' || words[i] === 'time') i++;
          }
          break;
        }
        case 'immune':
          out.push({kind: 'immune', mon: last});
          break;
        case 'immuneAfter': {
          // "It doesn't affect the opposing Salamence…"
          const m = nextMon(i, 4);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'immune', mon: m.ref});
          } else out.push({kind: 'immune', mon: last});
          break;
        }
        case 'knockOff':
        case 'steal': {
          // "…knocked off the opposing Garchomp's Sitrus Berry!", "…stole Garchomp's Sitrus Berry!"
          const m = nextMon(i, 3);
          const it = m ? itemAt(m.at + m.len, m.ref) : null;
          if (m && it) {
            named(m.ref, m.at + m.len + it.len);
            out.push({kind: 'item', mon: m.ref, item: it.value, gone: true});
          }
          break;
        }
        case 'itemGone':
        case 'seen':
        case 'whiteHerb': {
          // "…flung its Iron Ball!", "…returned its stats to normal using its White Herb!"; "…found its Leftovers!"
          const it = last ? itemAt(i, last) : null;
          if (last && it) {
            out.push({kind: 'item', mon: last, item: it.value, gone: ph.kind !== 'seen'});
            i += it.len;
          }
          break;
        }
        case 'blewAway': {
          // "…blew away Stealth Rock!" (Rapid Spin, Mortal Spin): off its own side.
          const h = HAZARDS.find(([p]) => p.every((w, k) => words[i + k] === w));
          if (h && last) {
            out.push({kind: 'field', news: {what: h[1], value: false, side: last.side}});
            i += h[0].length;
          }
          break;
        }
        case 'quickDraw': {
          // "Quick Draw made the opposing Slowbro move faster!"
          const m = nextMon(i, 3);
          if (m) {
            named(m.ref, m.at + m.len);
            out.push({kind: 'ability', mon: m.ref, ability: 'Quick Draw'});
          }
          break;
        }
        case 'maxAttack':
          // Anger Point: "…maxed its Attack!"
          if (last) out.push({kind: 'stat', mon: last, boosts: {atk: 1}, limit: true});
          break;
        case 'skipMove': {
          // "…took the Future Sight attack!"
          const mv = matchAt(words, i, every(env.gen, 'moves'), 0.84, 0.03);
          if (mv) i += mv.len;
          break;
        }
        case 'popped':
          if (last) out.push({kind: 'item', mon: last, item: 'Air Balloon', gone: true});
          break;
        case 'obtained': {
          // Trick's "…obtained a Choice Scarf." says where an item went, not what it had.
          const j = words[i] === 'a' || words[i] === 'an' ? i + 1 : i;
          const it = matchAt(words, j, every(env.gen, 'items'), 0.8, 0.04);
          if (it) i = j + it.len;
          break;
        }
        case 'reacting': {
          // "…is reacting to Roman's Omni Ring!": the trainer's name isn't a Pokémon.
          const k = words.slice(i, i + 6).findIndex(w => MEGA_GEAR.has(w));
          i = Math.min(words.length, k >= 0 ? i + k + 1 : i + 2);
          break;
        }
        case 'dragged':
          if (last) out.push({kind: 'dragged', mon: last});
          break;
        case 'skip':
          break;
        case 'copied': {
          // Psych Up: "Milotic copied Baxcalibur's stat changes!" (the one copied is never "the opposing": either side's).
          // Role Play ("…copied Incineroar's Intimidate Ability!") reads on: the ability is the other one's.
          const from = nextMon(i, 3);
          const k = from ? from.at + from.len : -1;
          if (last && from && !same(from.ref, last) && words[k] === 'stat' && words[k + 1] === 'changes') {
            out.push({kind: 'copyBoosts', mon: last, from: from.ref});
            i = k + 2;
          }
          break;
        }
        case 'inverted':
          // Topsy-Turvy: "All stat changes on the opposing Salamence were inverted!"
          if (last) out.push({kind: 'copyBoosts', mon: last, from: last, invert: true});
          break;
        case 'offer':
        case 'postponed':
          // After You ("…took the kind offer!"), Quash ("…'s move was postponed!").
          if (last) out.push({kind: 'outOfTurn', mon: last});
          break;
        case 'followed': {
          // Instruct: "Charizard followed Incineroar's instructions!"
          const by = nextMon(i, 3);
          if (last && by && words[by.at + by.len] === 'instructions') {
            out.push({kind: 'outOfTurn', mon: last, again: true});
            i = by.at + by.len + 1;
          }
          break;
        }
        case 'transformedInto': {
          // "…transformed into the Water type!" (Protean, Libero, Soak); "…transformed into Incineroar!" (Transform, Imposter).
          const j = words[i] === 'the' ? i + 1 : i;
          const type = TYPES.get(words[j] ?? '');
          const into = type && words[j + 1] === 'type' ? null : nextMon(i, 4);
          if (last && type && !into) {
            out.push({kind: 'types', mon: last, to: type});
            i = j + 2;
          } else if (last && into) {
            out.push({kind: 'odd', mon: last});
            i = into.at + into.len;
          }
          break;
        }
        case 'typeAdded': {
          // "Ghost type was added to the opposing Salamence!": the type before, the Pokémon after.
          const type = TYPES.get(words[start - 1] ?? '');
          const m = nextMon(i, 4);
          if (type && m) {
            out.push({kind: 'types', mon: m.ref, add: type});
            named(m.ref, m.at + m.len);
          }
          break;
        }
        case 'sameType': {
          // Reflect Type: "Charizard became the same type as the opposing Salamence!"
          const like = nextMon(i, 4);
          if (last && like && !same(like.ref, last)) {
            out.push({kind: 'types', mon: last, like: like.ref});
            i = like.at + like.len;
          }
          break;
        }
        case 'burnedOut':
          if (last) out.push({kind: 'types', mon: last, lose: 'Fire'});
          break;
        case 'noElectricity':
          if (last) out.push({kind: 'types', mon: last, lose: 'Electric'});
          break;
        case 'typeBack':
          if (last) out.push({kind: 'types', mon: last, back: true});
          break;
        case 'oddChange':
          if (last) out.push({kind: 'odd', mon: last});
          break;
        case 'places':
          // Ally Switch: the two of the side just named.
          if (last) out.push({kind: 'places', side: last.side});
          break;
        case 'skipCount': {
          // "…stockpiled 2!": a count, not HP.
          const n = numberAt(words, i);
          if (n) i += n.len;
          break;
        }
        case 'sendOut': {
          // "The opposing trainer sent out Kingambit!" (the game says it only of theirs), "I sent Dragapult".
          const m = nextOnSide(i, 5, ctx ?? 'opp');
          if (m) sentOut(m);
          break;
        }
        case 'lead': {
          // "Opponent leads with Rillaboom and Corviknight", "I lead Dragapult and Arcanine".
          const m = ctx ? nextOnSide(i, 5, ctx) : nextMon(i, 5);
          if (m) sentOut(m);
          break;
        }
        case 'go': {
          // "Go! Garchomp!"
          const m = sideAt(i, 'me');
          if (m) sentOut(m);
          break;
        }
        case 'withdraw':
        case 'withdrawAfter': {
          // "Salamence, come back!", "Garchomp went back to Roman!" are about the one just named;
          // "The opposing trainer withdrew Salamence!", "Come back, Salamence!" name it after. "… withdrew" is
          // only ever said of theirs (yours are told "…, come back!"), so of a species both sides have, theirs.
          const theirs = ph.kind === 'withdrawAfter' ? nextOnSide(i, 3, ctx === 'me' ? 'me' : 'opp') : null;
          const m = ph.kind === 'withdraw' && afterName ? null : theirs ?? nextMon(i, 3);
          if (m) named(m.ref, m.at + m.len);
          const gone = m?.ref ?? last;
          if (gone && live.active[gone.side].includes(gone.slot)) room[gone.side]++;
          out.push({kind: 'withdraw', mon: gone, voluntary: ph.extra === 'voluntary' || undefined});
          // "…went back to Roman!": the trainer's name isn't a Pokémon.
          if (words[i] === 'to') i = Math.min(words.length, i + 2);
          break;
        }
        case 'mega': {
          // "Charizard has Mega Evolved into Mega Charizard Y!", or said: "Lopunny mega", "mega Lopunny".
          const bare = ph.len === 1;
          const next = bare ? monAt(i) : null;
          const mon = bare ? next?.ref ?? (afterName ? last : undefined) : last ?? nextMon(i, 5)?.ref;
          if (bare && !mon) break;
          let suffix: string | undefined;
          for (let j = i; j < Math.min(words.length, i + 5); j++) {
            if (words[j] === 'x' || words[j] === 'y') {
              suffix = words[j].toUpperCase();
              break;
            }
          }
          out.push({kind: 'mega', mon, suffix});
          // "…into Mega Charizard Y": the same one again.
          if (!bare && words[i] === 'into') {
            let j = words[i + 1] === 'mega' ? i + 2 : i + 1;
            const again = monAt(j);
            if (again) {
              j += again.len;
              if (words[j] === 'x' || words[j] === 'y') j++;
              i = j;
            }
          }
          break;
        }
        case 'endTurn':
          out.push({kind: 'endTurn'});
          last = undefined;
          break;
        case 'first':
        case 'last': {
          // Who: the Pokémon just named. Before or after whom, if another comes next ("outsped Dragapult").
          const other = nextMon(i, 3);
          if (other && last && !same(other.ref, last)) i = other.at + other.len;
          if (last) out.push({kind: 'order', mon: last, place: ph.kind, other: other && !same(other.ref, last) ? other.ref : undefined});
          break;
        }
      }
      continue;
    }

    const mon = monAt(i);
    if (mon) {
      named(mon.ref, i + mon.len);
      // "Lopunny 's Attack…": the possessive heard apart.
      let possessive = mon.possessive;
      if (words[i] === 's') {
        possessive = true;
        lastEnd = ++i;
      }
      // "The opposing Garchomp's Attack harshly fell!"
      const st = statAt(words, i);
      if (st) {
        statEvent(mon.ref, st);
        i += st.len;
        continue;
      }
      // Both of a side at once: "Charizard and Incineroar's Attack fell!", "The opposing Salamence and the opposing Kingambit's…"
      const both = words[i] === 'and' ? nextMon(i + 1, 3) : null;
      const st2 = both ? statAt(words, both.at + both.len) : null;
      if (both && st2 && !same(both.ref, mon.ref)) {
        statEvent(mon.ref, st2);
        statEvent(both.ref, st2);
        named(both.ref, both.at + both.len + st2.len);
        continue;
      }
      // "Rillaboom's Psychic Seed" is its item, not the move Psychic.
      const own = possessive ? abilityOrItemAt(i, mon.ref) : null;
      if (own) {
        out.push(own.event);
        i += own.len;
        continue;
      }
      // A line about it comes next ("…protected itself!", "…knocked off…", "…twisted the dimensions!"): not a move.
      if (phraseAt(words, i) || fieldAt(words, i)) continue;
      // "X used Y" (but "X used its Quick Claw" is an item, and "Garchomp's Earthquake was disabled!" no move used).
      let j = i;
      if (USED.has(words[j] ?? '')) j++;
      if (words[j] !== 'its' && words[j] !== 'their' && !(possessive && j === i)) {
        let mv = moveAt(j, mon.ref);
        // With no "used": the move's own name, spelled out ("has" only sounds like Haze).
        if (mv && j === i && (mv.score < 0.9 || !spelled(j, mv))) mv = null;
        // "used" misheard ("Rillaboom mus said Fake Out"): a move said exactly a word or two on still counts.
        for (let k = j + 1; !mv && j === i && k <= i + 2 && k < words.length; k++) {
          if (numberAt(words, k - 1) || monAt(k - 1) || phraseAt(words, k - 1) || COMMON_WORDS.has(words[k - 1])) break;
          const m = moveAt(k, mon.ref);
          if (m && m.score >= 0.9 && spelled(k, m)) [mv, j] = [m, k];
        }
        if (mv) {
          out.push({kind: 'use', actor: mon.ref, move: mv.value});
          i = j + mv.len;
          // "…on Charizard", "…at the opposing Salamence": who it was aimed at.
          const t = TARGET_WORDS.has(words[i] ?? '') ? nextMon(i + 1, 3) : null;
          if (t && !same(t.ref, mon.ref)) {
            out.push({kind: 'target', mon: t.ref});
            named(t.ref, t.at + t.len);
          } else if (!t) {
            // "Lopunny Fake Out Bellibolt": one named straight after a move aimed at one is its target,
            // unless it's the next to move ("…Bellibolt Thunderbolt"). Its name is read on (its HP, a line about it).
            const side = aimedSide(mv.value, mon.ref);
            const n = side ? sideAt(i, side) : null;
            if (n && !same(n.ref, mon.ref) && !movesAt(i + n.len, n.ref)) out.push({kind: 'target', mon: n.ref});
          }
          continue;
        }
      }
      // "Charizard 45", "Charizard at 45", "Charizard down to 45 percent"
      let k = i;
      while (k < i + 3 && BEFORE_HP.has(words[k] ?? '')) k++;
      const num = numberAt(words, k);
      if (num) {
        out.push({kind: 'hp', mon: mon.ref, value: num.value});
        i = k + num.len;
        if (AFTER_HP.has(words[i] ?? '')) i++;
        continue;
      }
      // "The opposing Salamence Intimidate" (the possessive not heard)
      const ab = abilityOrItemAt(i, mon.ref);
      if (ab) {
        out.push(ab.event);
        i += ab.len;
      } else if (benched(mon.ref) && room[mon.ref.side] > 0) {
        // A benched Pokémon named with a place free on its side has come in: the leads said plainly
        // ("opponent Rillaboom and Corviknight"), or who replaced one that fainted.
        out.push({kind: 'sendOut', mon: mon.ref});
        room[mon.ref.side]--;
      }
      continue;
    }

    // "Intimidate from Incineroar": its ability, said the other way round.
    const from = words[i + 1] === 'from' ? i + 1 : words[i + 2] === 'from' ? i + 2 : -1;
    const whose = from > i ? nextMon(from + 1, 3) : null;
    const said = whose ? abilityAt(i, whose.ref) : null;
    if (whose && said && said.len === from - i) {
      out.push({kind: 'ability', mon: whose.ref, ability: said.value});
      named(whose.ref, whose.at + whose.len);
      continue;
    }

    // "Its Attack rose!"
    if (words[i] === 'its' && last) {
      const st = statAt(words, i + 1);
      if (st) {
        statEvent(last, st);
        i += 1 + st.len;
        continue;
      }
    }

    const item = matchAt(words, i, every(env.gen, 'items'), 0.8, 0.04);
    if (item) {
      const j = i + item.len;
      // "Occa Berry weakened Flamethrower's power!": held by whoever the move hit, which the move being narrated knows.
      const who = words[j] === 'weakened' ? undefined : last;
      // "…had its Sitrus Berry stolen!"
      out.push({kind: 'item', mon: who, item: item.value, gone: words[j] === 'stolen' || undefined});
      i = j;
      continue;
    }

    const num = numberAt(words, i);
    // A number that counts something else ("…lost 4 PP from Protect!"), or no HP at all ("no one").
    if (num && (NOT_HP_AFTER.has(words[i + num.len] ?? '') || words[i - 1] === 'no')) {
      i += num.len;
      continue;
    }
    if (num) {
      out.push({kind: 'hp', value: num.value});
      i += num.len;
      if (AFTER_HP.has(words[i] ?? '')) i++;
      continue;
    }
    i++;
  }
  return out;
}
