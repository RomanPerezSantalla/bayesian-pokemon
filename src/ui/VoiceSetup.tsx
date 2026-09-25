/**
 * The voice model's download, offered the first time voice is turned on (and only then: the app
 * works without it), and a panel to see it, remove it or switch recogniser.
 */
import {useEffect, useState, useSyncExternalStore} from 'react';
import {
  checkInstalled, chooseBrowserVoice, chooseEngine, closeOffer, downloadModel, packSize, removeModel, voiceSetup,
} from '../speech/local';
import {mb} from '../speech/store';

const useVoiceSetup = () => useSyncExternalStore(voiceSetup.subscribe, voiceSetup.get, voiceSetup.get);

/** About the size of the pack (scripts/voice-pack.mjs), until the real one is known. */
const ABOUT = 148e6;

export function VoiceOffer() {
  const s = useVoiceSetup();
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    if (s.offer) void packSize().then(setSize);
  }, [s.offer]);
  if (!s.offer) return null;
  const p = s.progress;
  const total = p?.total || size || ABOUT;
  return (
    <>
      <div className="sheet-backdrop voice-offer-backdrop" onClick={p ? undefined : closeOffer} />
      <div className="sheet voice-offer" role="dialog" aria-modal="true" aria-labelledby="voice-offer-title">
        <div className="sheet-head">
          <span className="who" id="voice-offer-title">Voice needs a one-time download</span>
          <button className="btn sm ghost" onClick={closeOffer} aria-label="Close">✕</button>
        </div>
        <p>
          To understand Pokémon names, voice uses a speech model that runs on this device: {mb(total)}, downloaded
          once and kept for next time. What you say never leaves the device, and it works offline.
        </p>
        <p className="note">Best on Wi-Fi. Everything else works without it; you can remove it from the Battles page.</p>
        {p && (
          <div className="col" style={{gap: 4}}>
            <progress value={p.done} max={p.total || 1} />
            <span className="small muted" role="status">{p.total ? `${mb(p.done)} of ${mb(p.total)}` : 'Starting…'}</span>
          </div>
        )}
        {s.error && <div className="note alert" role="alert">{s.error}</div>}
        <div className="row">
          <button className="btn primary" disabled={!!p} onClick={() => void downloadModel()}>
            {p ? 'Downloading…' : s.error ? 'Try again' : `Download (${mb(total)})`}
          </button>
          <button className="btn" onClick={closeOffer}>{p ? 'Cancel' : 'Not now'}</button>
        </div>
        <button className="link-btn small" onClick={chooseBrowserVoice}>
          Use the browser’s own recogniser instead: no download, but it sends the audio away and often mishears names
        </button>
      </div>
    </>
  );
}

/** On the Battles page, beside the backups. */
export function VoicePanel() {
  const s = useVoiceSetup();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s.installed === undefined) void checkInstalled();
  }, [s.installed]);
  const remove = async () => {
    setBusy(true);
    try {
      await removeModel();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel col">
      <h3>Voice</h3>
      <div className="note">
        {s.installed
          ? `The speech model is on this device (${mb(s.installed.size)}).`
          : s.installed === null ? 'The speech model isn’t on this device: turning voice on offers to download it.' : 'Checking…'}
        {' '}
        {s.engine === 'browser' ? 'Voice uses the browser’s own recogniser.' : ''}
      </div>
      <div className="note">
        The model: <a href="https://huggingface.co/nvidia/parakeet-tdt_ctc-110m" target="_blank" rel="noreferrer">Parakeet
        TDT-CTC 110M</a> by NVIDIA (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY
        4.0</a>), in sherpa-onnx's 8-bit conversion, with Silero VAD and ONNX Runtime Web (MIT).
      </div>
      <div className="row">
        {s.installed && <button className="btn" disabled={busy} onClick={() => void remove()}>Remove the model</button>}
        {s.engine === 'browser'
          ? <button className="btn" onClick={() => chooseEngine('local')}>Use the speech model</button>
          : <button className="btn ghost" onClick={() => chooseEngine('browser')}>Use the browser’s recogniser</button>}
      </div>
    </div>
  );
}
