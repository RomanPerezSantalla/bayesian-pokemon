/**
 * The browser's speech recogniser (Web Speech API: Chrome on Android and desktop, Safari),
 * listening continuously until stopped. Final phrases come with the recogniser's alternatives;
 * the phrase still being spoken is exposed for display. On a phone it pauses while the app is in
 * the background or the screen is off, and picks up again on return.
 */
import {useEffect, useRef, useState} from 'react';

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
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: {error: string}) => void) | null;
  onend: (() => void) | null;
  onaudiostart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognizerClass(): (new () => Recognizer) | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer};
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const speechSupported = () => !!recognizerClass();

/** A session that ends this soon after starting, several times running, isn't going to work (no connection, mic busy). */
const QUICK_END_MS = 1500;
const QUICK_ENDS_TO_GIVE_UP = 4;

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function useSpeech(onFinal: (alternatives: string[]) => void, lang = 'en-US') {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognizer | null>(null);
  const want = useRef(false);
  const handler = useRef(onFinal);
  handler.current = onFinal;
  // Some Android builds repeat a final phrase, or send it again with more words appended.
  const lastFinal = useRef({text: '', at: 0});
  /** Heard audio this visit: the microphone was allowed, so a later refusal is the browser pausing us. */
  const heard = useRef(false);
  const startedAt = useRef(0);
  const quickEnds = useRef(0);

  const deliver = (alts: string[]) => {
    const text = alts[0]?.trim() ?? '';
    if (!text) return;
    const prev = lastFinal.current;
    const recent = Date.now() - prev.at < 4000;
    lastFinal.current = {text, at: Date.now()};
    if (recent && text === prev.text) return;
    if (recent && prev.text && text.startsWith(prev.text)) {
      handler.current([text.slice(prev.text.length)]);
      return;
    }
    handler.current(alts);
  };

  const quit = (message: string | null) => {
    want.current = false;
    rec.current?.abort();
    setListening(false);
    setInterim('');
    setError(message);
  };

  const begin = (r: Recognizer) => {
    try {
      startedAt.current = Date.now();
      r.start();
    } catch {
      // Still running (a restart racing the end of the last session): its end starts it again.
    }
  };

  const start = () => {
    const Ctor = recognizerClass();
    if (!Ctor) {
      setError('This browser has no speech recognition (use Chrome or Safari)');
      return;
    }
    const r = new Ctor();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 3;
    // Only the newest session counts: one being replaced (stopped, then Voice tapped again quickly) still ends later.
    const current = () => rec.current === r;
    r.onaudiostart = () => {
      heard.current = true;
    };
    r.onresult = e => {
      if (!current()) return;
      heard.current = true;
      quickEnds.current = 0;
      setError(null);
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) deliver(Array.from(res, a => a.transcript));
        else live += res[0]?.transcript ?? '';
      }
      setInterim(live);
    };
    r.onerror = e => {
      if (!current()) return;
      switch (e.error) {
        case 'not-allowed':
        case 'service-not-allowed':
          quit(heard.current ? 'Voice stopped: tap 🎙 Voice to go on' : 'The microphone is blocked for this site: allow it in the browser’s site settings');
          break;
        case 'audio-capture':
          quit('No microphone to listen with (another app using it?)');
          break;
        case 'network':
          setError('Voice needs a connection: the browser sends the audio away to transcribe it');
          break;
        case 'language-not-supported':
          quit('This browser can’t transcribe English');
          break;
        case 'no-speech':
        case 'aborted':
          break;
        default:
          setError(`Speech recognition: ${e.error}`);
      }
    };
    // It stops by itself after silences: start it again while listening is on (not while the app is hidden).
    r.onend = () => {
      if (!current()) return;
      if (!want.current) {
        setListening(false);
        setInterim('');
        return;
      }
      if (hidden()) return;
      quickEnds.current = Date.now() - startedAt.current < QUICK_END_MS ? quickEnds.current + 1 : 0;
      if (quickEnds.current >= QUICK_ENDS_TO_GIVE_UP) {
        quit('Voice keeps stopping (no connection? microphone in use?): tap 🎙 Voice to try again');
        return;
      }
      begin(r);
    };
    rec.current?.abort();
    want.current = true;
    quickEnds.current = 0;
    rec.current = r;
    setError(null);
    begin(r);
    setListening(true);
  };

  const stop = () => {
    want.current = false;
    rec.current?.stop();
    setListening(false);
    setInterim('');
  };

  // A phone locking its screen or switching apps: let go of the microphone, and take it back on return.
  useEffect(() => {
    const onVisibility = () => {
      const r = rec.current;
      if (!r || !want.current) return;
      if (hidden()) {
        r.abort();
        setInterim('');
      } else {
        quickEnds.current = 0;
        begin(r);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => () => {
    want.current = false;
    rec.current?.abort();
  }, []);

  return {listening, interim, error, start, stop};
}
