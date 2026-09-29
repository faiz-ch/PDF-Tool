import { useEffect, useState } from 'react';
import type { LimitSetting } from '../lib/types';

/** Size-limit picker. `allowDefault` adds "Use default" for per-group settings. */
export default function LimitSelect({
  value,
  onChange,
  allowDefault,
  defaultLabel,
}: {
  value: LimitSetting;
  onChange: (v: LimitSetting) => void;
  allowDefault?: boolean;
  defaultLabel?: string;
}) {
  const mode = value === 'default' ? 'default' : value === null ? 'none' : 'custom';
  return (
    <div className="flex items-center gap-2">
      <select
        className="input py-1"
        value={mode}
        onChange={(e) => {
          const m = e.target.value;
          onChange(m === 'default' ? 'default' : m === 'none' ? null : typeof value === 'number' ? value : 3);
        }}
      >
        {allowDefault && <option value="default">Use default{defaultLabel ? ` (${defaultLabel})` : ''}</option>}
        <option value="custom">Max size</option>
        <option value="none">No limit</option>
      </select>
      {mode === 'custom' && (
        <label className="flex items-center gap-1 text-sm">
          <MbInput value={value as number} onChange={onChange} />
          MB
        </label>
      )}
    </div>
  );
}

/** Keeps its own text so partial input like "0." can be typed; commits only valid positive numbers. */
function MbInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      min={0.1}
      step={0.5}
      className="input w-20 py-1"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n) && n > 0) onChange(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}
