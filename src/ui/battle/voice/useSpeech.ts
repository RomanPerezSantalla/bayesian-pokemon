/**
 * The browser's speech recogniser (Web Speech API: Chrome on Android and desktop, Safari),
 * listening continuously until stopped. Final phrases come with the recogniser's alternatives;
 * the phrase still being spoken is exposed for display.
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
    r.onresult = e => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) deliver(Array.from(res, a => a.transcript));
        else live += res[0]?.transcript ?? '';
      }
      setInterim(live);
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        want.current = false;
        setError('Microphone access was blocked');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setError(`Speech recognition: ${e.error}`);
      }
    };
    // It stops by itself after silences: start it again while listening is on.
    r.onend = () => {
      if (want.current) {
        try {
          r.start();
        } catch {
          // Already restarting.
        }
      } else {
        setListening(false);
        setInterim('');
      }
    };
    want.current = true;
    rec.current = r;
    setError(null);
    try {
      r.start();
      setListening(true);
    } catch (err) {
      setError(String(err));
    }
  };

  const stop = () => {
    want.current = false;
    rec.current?.stop();
    setListening(false);
    setInterim('');
  };

  useEffect(() => () => {
    want.current = false;
    rec.current?.abort();
  }, []);

  return {listening, interim, error, start, stop};
}
