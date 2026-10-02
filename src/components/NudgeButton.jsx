// "Nudge…" — poke whoever a record is waiting on, as a private Telegram message
// (api/nudge.js). `targets` is [{ to, label }]: the CHOICES this screen offers; the
// server decides which people each one means, and refuses a second nudge to the same
// people about the same record within the hour.
import React, { useState } from 'react';
import { api } from '../api.js';
import { FormModal } from './common.jsx';
import { Icon } from './NavIcons.jsx';

export function NudgeButton({ kind, id, targets, className = 'btn ghost sm' }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState('');
  if (!targets?.length) return null;

  async function submit({ to, note }) {
    const r = await api.nudge(kind, id, to, note);
    const label = targets.find((t) => t.to === to)?.label || 'them';
    setDone(r.sentTo?.length
      ? `Nudged ${r.sentTo.join(', ')}.${r.notConnected?.length ? ` Not on Telegram yet: ${r.notConnected.join(', ')}.` : ''}`
      : `Nobody in ${label} has Telegram connected yet — tell them another way.`);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className={className} onClick={() => { setDone(''); setOpen(true); }}>
        <Icon name="bell" /> Nudge…
      </button>
      {done && <span className="nudge-done muted sm" role="status">{done}</span>}
      {open && (
        <FormModal
          title="Nudge on Telegram"
          message="Sends a private message from the bot, with a link straight to this. Once an hour per person."
          submitLabel="Send nudge"
          fields={[
            { name: 'to', label: 'Who', type: 'select', value: targets[0].to,
              options: targets.map((t) => ({ value: t.to, label: t.label })) },
            { name: 'note', label: 'Note (optional)', type: 'textarea', rows: 2, placeholder: 'e.g. the buyer is still in the store' },
          ]}
          onSubmit={submit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
