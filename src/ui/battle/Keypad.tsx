/** Calculator-style pad: faster than the phone keyboard and it never covers the screen. */
export function Keypad({onKey, multi}: {onKey(k: string): void; multi: boolean}) {
  const b = (k: string, label: string, cls = '') => (
    <button key={k} className={cls} onClick={() => onKey(k)}>{label}</button>
  );
  return (
    <div className="keypad">
      {b('7', '7')}{b('8', '8')}{b('9', '9')}{b('del', '⌫')}
      {b('4', '4')}{b('5', '5')}{b('6', '6')}{b('ko', 'KO', 'ko')}
      {b('1', '1')}{b('2', '2')}{b('3', '3')}{multi ? b('next', 'next ▸') : b('0', '0')}
      {multi ? b('0', '0') : <button key="blank" disabled style={{opacity: 0}} />}
      <button className="ok" style={{gridColumn: 'span 3'}} onClick={() => onKey('ok')}>✓ Log</button>
    </div>
  );
}
