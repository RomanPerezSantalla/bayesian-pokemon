import {useEffect, useRef, useState} from 'react';
import {captureStream, startCapture, stopCapture, useCapture} from '../screen/capture';
import {startReader, stopReader, useReader} from '../screen/reader';
import {testLogOn} from '../testlog';

/** Only in the copies the screen reader is being built in (development and test), until it reads the battle. */
const offered = import.meta.env.DEV || testLogOn;

/** The top bar's switch: capture the game's window (BlueStacks). */
export function ScreenButton() {
  const c = useCapture();
  if (!offered) return null;
  return (
    <button className={`btn sm screen-btn${c.on ? ' on' : ''}`} disabled={c.picking} onClick={() => (c.on ? stopCapture() : startCapture())}
      title={c.on ? 'Stop capturing the game' : 'Capture the game’s window (BlueStacks), to read the battle from it'}>
      {c.on ? '● Capturing' : '▣ Capture game'}
    </button>
  );
}

/** What's being captured, small in a corner (it folds away): to see it's the right window, and that it shows. */
export function ScreenPanel() {
  const c = useCapture();
  const reader = useReader();
  const ref = useRef<HTMLVideoElement>(null);
  const [folded, setFolded] = useState(false);
  // Reading goes with capturing.
  useEffect(() => {
    if (!offered) return;
    if (c.on) startReader();
    else stopReader();
  }, [c.on]);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = c.on ? captureStream() : null;
  }, [c.on, folded]);
  if (!offered || (!c.on && !c.error)) return null;
  return (
    <div className={`screen-panel${folded ? ' folded' : ''}`}>
      {c.error && <div className="small bad">{c.error}</div>}
      {c.on && !folded && <video ref={ref} muted playsInline autoPlay />}
      {c.on && (
        <div className="row small">
          {c.black
            ? <span className="bad">Nothing shows: this browser can’t capture that window. Share the whole screen, or try Edge or Chrome.</span>
            : <span className="muted">{c.width}×{c.height}{testLogOn ? ` · ${c.saved} frames saved` : ''}{reader.status === 'loading' ? ' · loading the reader…' : reader.status === 'reading' ? ' · reading' : reader.status === 'error' ? ` · reader: ${reader.error}` : ''}</span>}
          <div className="spacer" />
          <button className="btn sm ghost" onClick={() => setFolded(!folded)} title={folded ? 'Show what’s captured' : 'Fold away'}>{folded ? '▢' : '–'}</button>
        </div>
      )}
    </div>
  );
}
