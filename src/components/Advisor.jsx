// The advisor — a floating button on every staff screen, and the panel it opens.
//
// Mounted ONCE, next to the router in App.jsx, so no individual screen has to know it
// exists. A screen that wants the advisor to see what it's showing calls
// `useAdvisorContext()` (lib/advisorContext.js); everything else still gets a working
// advisor that can look things up for itself (api/advisor/ask.js).
//
// It answers two different kinds of question, which is why it's app-wide rather than
// bolted to the calculator: "is this pair worth buying" needs the screen, and "how do I
// shelve a pair with no box" needs our written procedures. Both go to the same place.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './NavIcons.jsx';
import { getAdvisorContext, ADVISOR_NAME, ADVISOR_INITIALS } from '../lib/advisorContext.js';
import { estClock } from '../lib/format.js';

// The advisor writes markdown — mostly **bold** around the numbers or the step that
// carries the answer, occasionally `code` for a SKU or VIN. Render that as React
// ELEMENTS.
//
// Never as HTML. This is model output quoting strings from Alias, StockX, our database
// and our SOPs; `dangerouslySetInnerHTML` here would be an XSS hole wearing a
// formatting hat. Splitting on the markers gives the formatting with none of the risk,
// and anything else renders literally — which is why the prompt asks for plain prose.
export function RichText({ text }) {
  const parts = String(text ?? '').split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return parts.map((part, i) => {
    if (/^\*\*[^*\n]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^`[^`\n]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// Openers, chosen from what the screen is showing. An empty box asking to be impressed
// gets used once; three concrete questions get used daily.
function suggestionsFor(ctx, role) {
  if (ctx?.sku) {
    return ['Is this a good buy?', 'What if I get it $20 cheaper?', 'Have we sold this before?'];
  }
  if (role === 'ph_team') {
    return ['What’s waiting to be listed?', 'How do I price a rescaled pair?', 'What does the GOAT-only chip mean?'];
  }
  return ['What needs doing today?', 'How do I shelve a pair with no box?', 'Where is VIN…?'];
}

export function Advisor({ user }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [off, setOff] = useState('');   // set when the server has no model key
  const logRef = useRef(null);
  const inputRef = useRef(null);

  // Follow the conversation down as it grows.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat, asking]);

  // Escape closes it — the panel covers content on a phone.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function ask(text) {
    const q = String(text ?? question).trim();
    if (!q || asking) return;
    const next = [...chat, { role: 'user', content: q, at: Date.now() }];
    setChat(next); setQuestion(''); setAsking(true);
    try {
      // Read the context at ASK time, not at open time: someone types a cost, then
      // asks. The answer must reflect the screen as it is now.
      const res = await api.advisorAsk(next, getAdvisorContext());
      setChat([...next, { role: 'assistant', content: res.reply, at: Date.now() }]);
    } catch (err) {
      // 503 is a setup fact, not a failed question — retire the panel rather than
      // leaving an error bubble that invites a retry which cannot work.
      if (err.status === 503) { setOff(err.message); setChat(chat); return; }
      setChat([...next, { role: 'error', content: err.message, at: Date.now() }]);
    } finally { setAsking(false); }
  }

  const ctx = getAdvisorContext();
  const suggestions = suggestionsFor(ctx, user?.role);

  return (
    <>
      <button type="button" className={`advisor-fab${open ? ' on' : ''}`}
        aria-label={open ? `Close ${ADVISOR_NAME}` : `Ask ${ADVISOR_NAME}`} aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 60); }}>
        {open ? <span aria-hidden="true">✕</span> : <Icon name="chat" />}
      </button>

      {open && (
        <div className="advisor-panel" role="dialog" aria-label={ADVISOR_NAME}>
          <div className="advisor-head">
            <span className="ah-avatar" aria-hidden="true">{ADVISOR_INITIALS}</span>
            <span className="advisor-title">{ADVISOR_NAME}</span>
            <span className="muted sm ah-sub">
              {ctx?.page ? `sees ${ctx.page}` : 'stock, backlog & how-to'}
            </span>
            {chat.length > 0 && (
              <button type="button" className="btn ghost sm" onClick={() => setChat([])}>Clear</button>
            )}
          </div>

          {off ? (
            <p className="muted sm advisor-empty">{off}</p>
          ) : (
            <>
              <div className="advisor-log" ref={logRef}>
                {chat.length === 0 && (
                  <div className="advisor-suggest">
                    {suggestions.map((q) => (
                      <button type="button" key={q} className="btn ghost sm" disabled={asking}
                        onClick={() => (q.endsWith('…?') ? setQuestion(q.replace('…?', ' ')) : ask(q))}>{q}</button>
                    ))}
                  </div>
                )}
                {chat.map((m, i) => (
                  <div className={`ah-row ${m.role}`} key={i}>
                    {m.role !== 'user' && <span className="ah-avatar sm" aria-hidden="true">{ADVISOR_INITIALS}</span>}
                    <div className={`ah-msg ${m.role}`}>
                      <span className="ah-who">
                        {m.role === 'user' ? 'You' : m.role === 'error' ? `${ADVISOR_NAME} couldn’t answer` : ADVISOR_NAME}
                        {m.at ? <span className="ah-time">{estClock(m.at)}</span> : null}
                      </span>
                      <span className="ah-body">
                        {m.role === 'assistant' ? <RichText text={m.content} /> : m.content}
                      </span>
                    </div>
                  </div>
                ))}
                {asking && (
                  <div className="ah-row assistant">
                    <span className="ah-avatar sm" aria-hidden="true">{ADVISOR_INITIALS}</span>
                    <div className="ah-msg assistant">
                      <span className="ah-who">{ADVISOR_NAME}</span>
                      <span className="ah-body ah-typing" aria-label="typing">
                        <i /><i /><i />
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <form className="advisor-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
                <input ref={inputRef} type="text" value={question} disabled={asking}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder={`Message ${ADVISOR_NAME}…`}
                  aria-label="Ask the advisor" />
                <button type="submit" className="btn" disabled={asking || !question.trim()}>
                  {asking ? '…' : 'Ask'}
                </button>
              </form>
              <p className="advisor-note muted sm">
{ADVISOR_NAME} reads our stock and our written procedures. He can be wrong — the screens are the source of truth.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
