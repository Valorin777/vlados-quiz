import type { ReactNode } from 'react';

/** On/off switch with a chrome knob (a real checkbox underneath: keyboard, screen readers, forms). */
export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="lab-switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
      <i aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}
