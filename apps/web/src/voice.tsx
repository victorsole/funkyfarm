// Voice typing with Whisper on Funkyfarm's own server. The recording is sent once, transcribed,
// deleted, and the text lands in an editable field: nothing is saved until the person checks it.
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square } from 'lucide-react';
import { api, errorMessage } from './api';

let status: Promise<boolean> | null = null;
function speechAvailable() {
  status ??= api.get<{ enabled: boolean }>('/speech/status').then(result => result.enabled).catch(() => false);
  return status;
}
const recordingTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const LIMIT_SECONDS = 30;

export function VoiceButton({ onText, label = 'Say it' }: { onText: (text: string) => void; label?: string }) {
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    let active = true;
    void speechAvailable().then(enabled => { if (active) setAvailable(enabled && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia); });
    return () => { active = false; recorder.current?.state === 'recording' && recorder.current.stop(); if (timer.current) window.clearInterval(timer.current); };
  }, []);
  async function start() {
    setError('');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setError('Allow the microphone to use voice typing, or type instead.'); return; }
    const type = recordingTypes.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? '';
    const chunks: Blob[] = [];
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    media.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    media.onstop = async () => {
      stream.getTracks().forEach(track => track.stop());
      if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
      setState('working');
      try {
        const audio = new Blob(chunks, { type: (media.mimeType || type || 'audio/webm').split(';')[0] });
        // Farmers may speak another language than the interface; Whisper detects it (EU languages only).
        const result = await api.sendBlob<{ text: string }>('/speech/transcribe?language=auto', audio);
        if (result.text.trim()) onText(result.text.trim()); else setError('No words were recognised. Try again a little closer to the phone.');
      } catch (failure) { setError(errorMessage(failure)); }
      finally { setState('idle'); }
    };
    recorder.current = media;
    media.start();
    setSeconds(0); setState('recording');
    timer.current = window.setInterval(() => setSeconds(value => {
      if (value + 1 >= LIMIT_SECONDS) recorder.current?.stop();
      return value + 1;
    }), 1000);
  }
  if (!available) return null;
  return <div className="voice">
    <button type="button" className={`button button-secondary voice-button${state === 'recording' ? ' is-recording' : ''}`} aria-pressed={state === 'recording'}
      disabled={state === 'working'} onClick={() => state === 'recording' ? recorder.current?.stop() : void start()}>
      {state === 'recording' ? <Square aria-hidden="true"/> : state === 'working' ? <LoaderCircle className="voice-spin" aria-hidden="true"/> : <Mic aria-hidden="true"/>}
      {state === 'recording' ? `Stop (${seconds}s)` : state === 'working' ? 'Writing it down…' : label}
    </button>
    {error ? <span role="alert" className="voice-error">{error}</span> : <small className="muted">Transcribed on Funkyfarm’s server, then deleted. Check the text.</small>}
  </div>;
}

// Spoken crop names (English and Spanish) mapped onto the easy form's picture tiles.
const cropWords: [RegExp, string][] = [
  [/\b(wheat|barley|trigo|cebada|ordi)\b/, 'Wheat or barley'], [/\b(maize|corn|maiz)\b/, 'Maize'], [/(sunflower|girasol)/, 'Sunflower'],
  [/\b(grass|pasture|hierba|pasto|prado|herba)\b/, 'Grass'], [/\b(vine|vines|vineyard|vina|vinedo|vid|vinya)\b/, 'Vines'],
  [/(vegetable|hortaliza|huerta|verdura)/, 'Vegetables'],
];
export function cropFromSpeech(text: string) {
  const plain = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return cropWords.find(([pattern]) => pattern.test(plain))?.[1] ?? text.replace(/[.!?]+$/, '').slice(0, 200);
}
