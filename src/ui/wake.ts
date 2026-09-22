/**
 * Keeping a phone's screen on during a battle. Phones lock after half a minute or so untouched,
 * which is often while the eyes are on the Switch, and voice stops with them.
 */
import {useEffect, useRef, useState} from 'react';

/** Holds the screen on while `on` and the page is showing (the browser lets go when it's hidden; it's taken back on return). */
export function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || typeof navigator === 'undefined' || !navigator.wakeLock) return;
    let lock: WakeLockSentinel | null = null;
    let live = true;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const got = await navigator.wakeLock.request('screen');
        if (live) lock = got;
        else void got.release();
      } catch {
        // Refused (battery saver, or not allowed here): the screen locks as usual.
      }
    };
    const onVisibility = () => void acquire();
    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}

/**
 * Whether something happened in the last `ms`: a tap or key anywhere, or a change of `bump` (a
 * move logged by voice). After a while of nothing the battle's likely over, and the screen can sleep.
 */
export function useRecentActivity(ms: number, bump: unknown): boolean {
  const [recent, setRecent] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const poke = useRef(() => {});
  poke.current = () => {
    setRecent(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setRecent(false), ms);
  };
  useEffect(() => {
    const onInput = () => poke.current();
    window.addEventListener('pointerdown', onInput);
    window.addEventListener('keydown', onInput);
    return () => {
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => poke.current(), [bump]);
  return recent;
}
