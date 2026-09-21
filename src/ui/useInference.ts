import {useEffect, useRef, useState} from 'react';
import type {FormatData} from '../data/format';
import type {Battle} from '../engine/types';
import type {InferResult, WorkerRequest} from '../engine/worker';

let worker: Worker | null = null;
let sentFormat: FormatData | null = null;
let nextId = 1;

function getWorker() {
  worker ??= new Worker(new URL('../engine/worker.ts', import.meta.url), {type: 'module'});
  return worker;
}

/**
 * Latest beliefs for a battle. Requests go to the worker as the battle changes;
 * stale replies are dropped, and the last good result stays on screen meanwhile.
 */
export function useInference(fmt: FormatData | null, battle: Battle | undefined, focus: number[]) {
  const [result, setResult] = useState<InferResult | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const w = getWorker();
    const onMessage = (e: MessageEvent<InferResult>) => {
      if (e.data.reqId !== latest.current) return;
      setBusy(false);
      if (e.data.error) console.error('inference failed:', e.data.error);
      else setResult(e.data);
    };
    w.addEventListener('message', onMessage);
    return () => w.removeEventListener('message', onMessage);
  }, []);

  const focusKey = focus.join(',');
  useEffect(() => {
    if (!fmt || !battle) return;
    const w = getWorker();
    if (sentFormat !== fmt) {
      w.postMessage({type: 'format', fmt} satisfies WorkerRequest);
      sentFormat = fmt;
    }
    const reqId = nextId++;
    latest.current = reqId;
    setBusy(true);
    w.postMessage({type: 'infer', reqId, battle, focus} satisfies WorkerRequest);
    // Everything that matters is in `battle` (events, live state for matchups) and the focus list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmt, battle, focusKey]);

  return {result, busy};
}
