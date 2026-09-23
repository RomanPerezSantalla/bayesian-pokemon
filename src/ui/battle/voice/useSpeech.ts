/**
 * Listening continuously until stopped, with the voice model on this device (speech/local.ts) or
 * the browser's own recogniser (Web Speech API: Chrome, Safari). There's one session for the whole app, so the microphone
 * stays on from team preview into the battle: whichever screen is showing takes the phrases (the
 * team preview, then the battle's narrator), and a phrase heard in between waits a few seconds for
 * the next one. On a phone it pauses while the app is in the background or the screen is off, and
 * picks up again on return.
 */
import {useEffect, useRef, useSyncExternalStore} from 'react';
import {gateVoice, LocalRecognizer, localReady, wantsLocal} from '../../../speech/local';
import {testLog} from '../../../testlog';

interface Alternative {
  transcript: string;
}
interface Result extends ArrayLike<Alternative> {
  isFinal: boolean;
}
interface ResultEvent {
  resultIndex: number;
  results: ArrayLike<Result>;
}
/** What the voice model is doing, for the screen to show. */
export type Activity = 'loading' | 'hearing' | 'reading' | null;

export interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: {error: string}) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  /** Each result is a whole line (the voice model finds where lines end): no putting pieces together. */
  wholePhrases?: boolean;
  /** Names and moves that can come up right now, for a recogniser that listens out for them. */
  context?: () => string[];
  onactivity?: ((a: Activity) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognizerClass = new () => Recognizer;

function browserRecognizer(): RecognizerClass | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {SpeechRecognition?: RecognizerClass; webkitSpeechRecognition?: RecognizerClass};
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** The voice model once it's here (and not turned down), else the browser's. */
function appRecognizer(): RecognizerClass | undefined {
  return wantsLocal() && localReady() ? LocalRecognizer : browserRecognizer();
}

export interface SpeechState {
  listening: boolean;
  /** The phrase still being spoken. */
  interim: string;
  error: string | null;
  activity: Activity;
}

/** A session that ends this soon after starting, several times running, isn't going to work (no connection, mic busy). */
const QUICK_END_MS = 1500;
const QUICK_ENDS_TO_GIVE_UP = 4;
/** A phrase heard with no screen taking phrases (team preview becoming the battle) waits this long for the next one. */
export const WAIT_MS = 10_000;
/** No screen taking phrases for this long (you left the battle): listening stops. */
export const IDLE_MS = 10_000;
/** This long with nothing new heard ends a phrase. */
export const QUIET_MS = 1300;

/** Letters only, for comparing what was heard however it was split or capitalised. */
const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** `b` is `a` said again with a word or two changed ("…relay boom gardeno" → "…relay boom gardenia"). */
function revises(a: string, b: string) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return p >= 0.75 * a.length && b.length >= 0.75 * a.length;
}

/** The words of `text` after the ones that spell `prefix` (letters only). */
function after(text: string, prefix: string) {
  const words = text.trim().split(/\s+/);
  let got = '';
  let k = 0;
  while (k < words.length && got.length < prefix.length) got += letters(words[k++]);
  return words.slice(k).join(' ');
}

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class SpeechSession {
  private state: SpeechState = {listening: false, interim: '', error: null, activity: null};
  private readonly listeners = new Set<() => void>();
  private rec: Recognizer | null = null;
  private want = false;
  /** Heard audio this visit: the microphone was allowed, so a later refusal is the browser pausing us. */
  private heard = false;
  private startedAt = 0;
  private quickEnds = 0;
  /**
   * The phrase being heard. Chrome on Android sends a phrase in pieces, each marked final ("idiot
   * King", " Gambit", " Carbonite"), then often the whole again, sometimes revised; read one piece
   * at a time, a name split in two never matches. So pieces are put together, and the phrase goes
   * out after a moment of quiet.
   */
  private phrase: {text: string; alternatives: string[]} | null = null;
  private pieces: string[] = [];
  private quiet: ReturnType<typeof setTimeout> | undefined;
  /** The last phrase sent, to drop it arriving again. */
  private lastFinal = {letters: '', at: 0};
  private taker: ((alternatives: string[]) => void) | null = null;
  private context: (() => string[]) | null = null;
  private waiting: {alternatives: string[]; at: number}[] = [];
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly recognizer: () => RecognizerClass | undefined = browserRecognizer,
    private readonly lang = 'en-US',
    /** Before listening starts: false holds it back (the app offers the voice model's download first). */
    private readonly gate: ((start: () => void) => boolean) | null = null,
  ) {
    // A phone locking its screen or switching apps: let go of the microphone, and take it back on return.
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  readonly subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  readonly getState = () => this.state;

  private set(patch: Partial<SpeechState>) {
    const next = {...this.state, ...patch};
    if (next.listening === this.state.listening && next.interim === this.state.interim && next.error === this.state.error
      && next.activity === this.state.activity) return;
    this.state = next;
    for (const fn of this.listeners) fn();
  }

  /**
   * `fn` takes the phrases from now on, starting with any heard in the last few seconds that nobody
   * took. Returns the function that lets go; if nobody takes over soon after, listening stops.
   */
  take(fn: (alternatives: string[]) => void, context?: () => string[]): () => void {
    this.taker = fn;
    this.context = context ?? null;
    clearTimeout(this.idle);
    const now = Date.now();
    const waiting = this.waiting.filter(w => now - w.at < WAIT_MS);
    this.waiting = [];
    for (const w of waiting) fn(w.alternatives);
    return () => {
      if (this.taker !== fn) return;
      this.taker = null;
      this.context = null;
      clearTimeout(this.idle);
      this.idle = setTimeout(() => {
        if (!this.taker && this.want) this.stop();
      }, IDLE_MS);
    };
  }

  /** Leaves a phrase for whoever takes over next: the battle's first line, heard at team preview, goes to the battle. */
  passOn(alternatives: string[]) {
    this.waiting.push({alternatives, at: Date.now()});
  }

  private hand(alternatives: string[]) {
    if (this.taker) {
      this.taker(alternatives);
      return;
    }
    this.waiting.push({alternatives, at: Date.now()});
    if (this.waiting.length > 10) this.waiting.shift();
  }

  /** A final piece from the recogniser, into the phrase being heard. */
  private piece(alternatives: string[]) {
    const raw = alternatives[0] ?? '';
    const text = raw.trim();
    if (!text) return;
    this.pieces.push(raw);
    const now = this.phrase;
    if (!now) {
      this.phrase = {text, alternatives: alternatives.map(a => a.trim())};
      return;
    }
    // " Gambit": the phrase goes on.
    if (/^\s/.test(raw)) {
      this.phrase = {text: `${now.text} ${text}`, alternatives: [`${now.text} ${text}`]};
      return;
    }
    const a = letters(now.text);
    const b = letters(text);
    // The whole again (maybe capitalised or split differently), or its start: nothing new.
    if (a === b || a.startsWith(b)) return;
    // The whole again with more, or with a word revised: this one's better.
    if (b.startsWith(a) || revises(a, b)) {
      this.phrase = {text, alternatives: alternatives.map(a => a.trim())};
      return;
    }
    // The next phrase straight after: read together, they say the same.
    this.phrase = {text: `${now.text} ${text}`, alternatives: [`${now.text} ${text}`]};
  }

  /**
   * The phrase heard, out to whoever takes it (once: the same again soon after is dropped, as the
   * browser's recogniser resends; a `whole` line from the voice model said twice was said twice).
   */
  private flush(whole = false) {
    clearTimeout(this.quiet);
    const done = this.phrase;
    const pieces = this.pieces;
    this.phrase = null;
    this.pieces = [];
    if (!done) return;
    this.set({interim: ''});
    const text = done.text;
    const now = letters(text);
    const prev = this.lastFinal;
    const recent = Date.now() - prev.at < 5000;
    this.lastFinal = {letters: now, at: Date.now()};
    testLog('speech', {pieces, text});
    if (whole) {
      this.hand(done.alternatives);
      return;
    }
    if (recent && (now === prev.letters || prev.letters.startsWith(now))) return;
    if (recent && prev.letters && now.startsWith(prev.letters)) {
      const extra = after(text, prev.letters);
      if (extra) this.hand([extra]);
      return;
    }
    this.hand(done.alternatives);
  }

  private quit(message: string | null) {
    this.want = false;
    this.rec?.abort();
    this.set({listening: false, interim: '', error: message, activity: null});
  }

  private begin(r: Recognizer) {
    try {
      this.startedAt = Date.now();
      r.start();
    } catch {
      // Still running (a restart racing the end of the last session): its end starts it again.
    }
  }

  readonly start = () => {
    if (this.gate && !this.gate(this.start)) return;
    const Ctor = this.recognizer();
    if (!Ctor) {
      const firefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
      // Only with the browser's recogniser chosen: the voice model works anywhere.
      this.set({error: firefox
        ? 'Firefox has no speech recognition of its own: switch voice to the speech model (Battles page), or open this page in Chrome'
        : 'This browser has no speech recognition of its own: switch voice to the speech model (Battles page), or use Chrome or Safari'});
      return;
    }
    const r = new Ctor();
    r.lang = this.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3;
    // Only the newest session counts: one being replaced (stopped, then Voice tapped again quickly) still ends later.
    const current = () => this.rec === r;
    r.context = () => this.context?.() ?? [];
    r.onactivity = a => {
      if (current()) this.set({activity: a});
    };
    r.onaudiostart = () => {
      this.heard = true;
    };
    r.onresult = e => {
      if (!current()) return;
      this.heard = true;
      this.quickEnds = 0;
      if (r.wholePhrases) {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const alternatives = res.isFinal ? Array.from(res, a => a.transcript.trim()).filter(Boolean) : [];
          if (!alternatives.length) continue;
          this.phrase = {text: alternatives[0], alternatives};
          this.pieces = [alternatives[0]];
          this.flush(true);
        }
        this.set({error: null});
        return;
      }
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.piece(Array.from(res, a => a.transcript));
        else live += res[0]?.transcript ?? '';
      }
      // Shown as it comes: the phrase put together so far, then what's still being said.
      this.set({interim: [this.phrase?.text, live.trim()].filter(Boolean).join(' '), error: null});
      clearTimeout(this.quiet);
      this.quiet = setTimeout(() => this.flush(), QUIET_MS);
    };
    r.onerror = e => {
      if (!current()) return;
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          this.quit(this.heard ? 'Voice stopped: tap 🎙 Voice to go on' : 'The microphone is blocked for this site: allow it in the browser’s site settings');
          break;
        case 'audio-capture':
          this.quit('No microphone to listen with (another app using it?)');
          break;
        case 'network':
          this.set({error: 'Voice needs a connection: the browser sends the audio away to transcribe it'});
          break;
        case 'model':
          this.quit('The voice model isn’t on this device: tap 🎙 Voice to download it again');
          break;
        case 'model-update':
          this.quit('The voice model needs an update for this version of the app: tap 🎙 Voice to download it');
          break;
        case 'language-not-supported':
          this.quit('This browser can’t transcribe English');
          break;
        case 'no-speech':
        case 'aborted':
          break;
        default:
          this.set({error: `Speech recognition: ${e.error}`});
      }
    };
    // It stops by itself after silences: start it again while listening is on (not while the app is hidden).
    r.onend = () => {
      if (!current()) return;
      // A session ending (a pause, stopping, the app hidden) ends the phrase too.
      this.flush();
      if (!this.want) {
        this.set({listening: false, interim: '', activity: null});
        return;
      }
      if (hidden()) return;
      this.quickEnds = Date.now() - this.startedAt < QUICK_END_MS ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= QUICK_ENDS_TO_GIVE_UP) {
        this.quit('Voice keeps stopping (no connection? microphone in use?): tap 🎙 Voice to try again');
        return;
      }
      this.begin(r);
    };
    this.rec?.abort();
    this.want = true;
    this.quickEnds = 0;
    this.rec = r;
    this.set({listening: true, error: null});
    this.begin(r);
  };

  readonly stop = () => {
    this.want = false;
    this.rec?.stop();
    this.set({listening: false, interim: '', activity: null});
  };

  private onVisibility() {
    const r = this.rec;
    if (!r || !this.want) return;
    if (hidden()) {
      r.abort();
      this.set({interim: ''});
    } else {
      this.quickEnds = 0;
      this.begin(r);
    }
  }
}

export const speech = new SpeechSession(appRecognizer, 'en-US', gateVoice);

/**
 * The session's state, with `onFinal` taking the phrases while this screen is showing, and
 * `context` saying what names and moves can come up on it.
 */
export function useSpeech(onFinal: (alternatives: string[]) => void, context?: () => string[]) {
  const state = useSyncExternalStore(speech.subscribe, speech.getState, speech.getState);
  const handler = useRef(onFinal);
  handler.current = onFinal;
  const phrases = useRef(context);
  phrases.current = context;
  useEffect(() => speech.take(alternatives => handler.current(alternatives), () => phrases.current?.() ?? []), []);
  return {...state, start: speech.start, stop: speech.stop};
}
