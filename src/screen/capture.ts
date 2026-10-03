/**
 * The game's screen, captured: the window the player picks (BlueStacks) through the browser's screen sharing,
 * looked at a frame at a time for the screen reader. The test copy (`npm run phone`) also saves the frames to the
 * PC (.cache/screen-frames/), to build the reader on and check it against.
 */
import {useSyncExternalStore} from 'react';
import {testLog, testLogFrame, testLogOn} from '../testlog';

export interface CaptureState {
  on: boolean;
  /** The browser's picker is open. */
  picking: boolean;
  width: number;
  height: number;
  /** Frames looked at, and saved (test copy). */
  frames: number;
  saved: number;
  /** Nothing but black for a few seconds: a window this browser can't capture, or one minimised. */
  black: boolean;
  error?: string;
}

/** Frames a second. The game's lines stay up a second or more. */
const FPS = 2;
/** The thumbnail compared from frame to frame: big enough for a new line of the game's text to show in it. */
const TW = 320;
const TH = 180;
/** A frame is saved when this many of the thumbnail's pixels changed visibly since the last one saved. */
const CHANGED = 12;
const VISIBLY = 16;
/** One saved at least this often while nothing changes. */
const KEEP_MS = 5000;
const BLACK_MS = 3000;
/** How often the test log hears how the capture is doing, so a capture that stalls shows when and how. */
const STATUS_MS = 30_000;
/** A frame still being made into a JPEG after this long has gone astray: saving goes on without it. */
const STUCK_MS = 5000;
/** How often a frame is handed to the screen reader (saving goes at FPS). */
const TICK_FPS = 4;

let state: CaptureState = {on: false, picking: false, width: 0, height: 0, frames: 0, saved: 0, black: false};
const listeners = new Set<() => void>();

function set(patch: Partial<CaptureState>) {
  state = {...state, ...patch};
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCapture(): CaptureState {
  return useSyncExternalStore(subscribe, () => state);
}

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let ticker: Worker | null = null;
let tickerUrl = '';
let session = '';

/** What's being captured, to show it. */
export const captureStream = () => stream;

const tickers = new Set<(video: HTMLVideoElement) => void>();

/** Each frame handed on (TICK_FPS a second while capturing): for the screen reader. */
export function onCaptureTick(fn: (video: HTMLVideoElement) => void): () => void {
  tickers.add(fn);
  return () => {
    tickers.delete(fn);
  };
}

export async function startCapture() {
  if (state.on || state.picking) return;
  set({picking: true, error: undefined});
  let s: MediaStream;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({video: {frameRate: {ideal: 10}}, audio: false});
  } catch (err) {
    // Closing the picker isn't an error.
    const name = err instanceof DOMException ? err.name : '';
    const quiet = name === 'NotAllowedError' || name === 'AbortError';
    set({picking: false, error: quiet ? undefined : `Couldn’t capture the screen: ${err instanceof Error ? err.message : String(err)}`});
    return;
  }
  stream = s;
  const track = s.getVideoTracks()[0];
  track.addEventListener('ended', () => stopCapture('sharing ended'));
  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = s;
  video.play().catch(() => {
    // It plays as frames come.
  });
  session = new Date().toISOString().replace(/[:.]/g, '-');
  const {width = 0, height = 0, frameRate} = track.getSettings();
  set({on: true, picking: false, width, height, frames: 0, saved: 0, black: false});
  testLog('screen', {session, source: track.label, width, height, frameRate, saving: testLogOn});
  lastStatus = Date.now();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  // A worker keeps the time: the page's own timers slow to once a second while it's behind another window.
  tickerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${Math.round(1000 / TICK_FPS)});`], {type: 'text/javascript'}));
  ticker = new Worker(tickerUrl);
  let tick = 0;
  ticker.onmessage = () => {
    if (video) for (const fn of tickers) fn(video);
    if (tick++ % (TICK_FPS / FPS) === 0) grab();
  };
}

export function stopCapture(reason = 'stopped') {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  ticker?.terminate();
  ticker = null;
  if (tickerUrl) URL.revokeObjectURL(tickerUrl);
  tickerUrl = '';
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  if (video) video.srcObject = null;
  video = null;
  last = null;
  darkSince = 0;
  if (state.on) testLog('screen', {session, stopped: true, reason, frames: state.frames, saved: state.saved});
  set({on: false, picking: false, black: false});
}

let thumb: CanvasRenderingContext2D | null = null;
let full: HTMLCanvasElement | null = null;
let last: Uint8Array | null = null;
let lastSaved = 0;
let darkSince = 0;
let saving = false;
let savingSince = 0;
let stuck = 0;
let frameNo = 0;
let lastStatus = 0;

const onVisibility = () => testLog('screen-change', {session, hidden: document.hidden});
const onPageHide = () => stopCapture('page closed');

function grab() {
  const v = video;
  const now = Date.now();
  if (now - lastStatus >= STATUS_MS) {
    lastStatus = now;
    testLog('screen-status', {session, frames: state.frames, saved: state.saved, black: state.black, hidden: document.hidden, ready: v?.readyState ?? -1, stuck});
  }
  if (saving && now - savingSince > STUCK_MS) {
    saving = false;
    stuck++;
  }
  if (!v || v.readyState < 2 || !v.videoWidth) return;
  const w = v.videoWidth;
  const h = v.videoHeight;
  thumb ??= Object.assign(document.createElement('canvas'), {width: TW, height: TH}).getContext('2d', {willReadFrequently: true});
  if (!thumb) return;
  thumb.drawImage(v, 0, 0, TW, TH);
  const px = thumb.getImageData(0, 0, TW, TH).data;
  const gray = new Uint8Array(TW * TH);
  let brightest = 0;
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (px[4 * i] * 299 + px[4 * i + 1] * 587 + px[4 * i + 2] * 114) / 1000;
    brightest = Math.max(brightest, gray[i]);
  }
  darkSince = brightest < 16 ? darkSince || now : 0;
  const black = darkSince > 0 && now - darkSince > BLACK_MS;
  if (black !== state.black) testLog('screen-change', {session, black});
  set({frames: state.frames + 1, width: w, height: h, black});
  if (!testLogOn || saving || black) return;
  if (last && changedPixels(gray, last) < CHANGED && now - lastSaved < KEEP_MS) return;
  last = gray;
  lastSaved = now;
  full ??= document.createElement('canvas');
  if (full.width !== w || full.height !== h) Object.assign(full, {width: w, height: h});
  full.getContext('2d')?.drawImage(v, 0, 0);
  const id = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${frameNo++}`;
  saving = true;
  savingSince = now;
  full.toBlob(blob => {
    saving = false;
    if (!blob) return;
    testLogFrame(session, id, blob);
    set({saved: state.saved + 1});
  }, 'image/jpeg', 0.9);
}

function changedPixels(a: Uint8Array, b: Uint8Array) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > VISIBLY) n++;
  return n;
}
