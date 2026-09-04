// The gift cards on a request: recording them, reading one back, and the photos.
//
// Two ways in, because the desk gets them both ways — a card's numbers pasted out of a
// supplier email, or a photograph of the physical card. Both land on the same request
// and both count toward the funding total; only the pasted ones can be typed into a
// till without opening an image, which is why pasting is the primary path.
//
// **What is on screen by default is the last four and the balance, never the code.**
// A cart page is opened on a warehouse floor, in a shop, over someone's shoulder — a
// full card number rendered on load is a number that can be photographed by anyone who
// walks past. Reading one is a deliberate act, it goes through its own endpoint, and
// the server writes who did it before it answers.
import React, { useState } from 'react';
import { api } from '../api.js';
import { PriceInput, CopyText, ImageZoomModal } from './common.jsx';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

// One card. Collapsed to `•••• 4821 · $200.00`; the code appears only after a tap, and
// hides itself again when the panel is closed.
function GiftCardRow({ cart, card, canReveal, canVoid, onChanged, onSignOut }) {
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function reveal() {
    setBusy(true); setErr('');
    try {
      setSecret(await api.cartGcReveal(cart.id, card.id));
      // Refresh so the reveal shows up in the trail immediately. The inline note claims
      // the reading was recorded; the history under it has to actually say so, or the
      // claim is something people take on faith. The revealed code survives this — the
      // row is keyed on the card id, so its local state isn't remounted.
      onChanged();
    } catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }

  async function voidIt() {
    const reason = window.prompt('Why is this card being withdrawn?');
    if (reason === null) return;
    setBusy(true); setErr('');
    try { await api.cartVoidGiftCard(cart.id, card.id, reason); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <li className={`bc-gc ${card.voided_at ? 'voided' : ''}`}>
      <div className="bc-gc-top">
        <span className="bc-gc-num">•••• {card.code_last4 || '????'}</span>
        <span className="bc-gc-bal">{money(card.balance)}</span>
        {card.label && <span className="muted sm">{card.label}</span>}
        {card.voided_at && <span className="po-chip muted">Withdrawn</span>}
        <span className="bc-gc-spacer" />
        {canReveal && !card.voided_at && !secret && (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={reveal}>
            {busy ? 'Reading…' : 'Show code'}
          </button>
        )}
        {secret && <button type="button" className="btn sm ghost" onClick={() => setSecret(null)}>Hide</button>}
        {canVoid && !card.voided_at && (
          <button type="button" className="btn sm danger" disabled={busy} onClick={voidIt}>Withdraw</button>
        )}
      </div>
      {secret && (
        <div className="bc-gc-secret">
          {/* Click-to-copy: the number goes into a till or a checkout field, and
              re-typing sixteen digits off a screen is how a card gets mistyped. */}
          <CopyText text={secret.code} className="bc-gc-code">{secret.code}</CopyText>
          {secret.pin && <CopyText text={secret.pin} className="bc-gc-pin">PIN {secret.pin}</CopyText>}
          <span className="muted xs">Reading this was recorded against your name.</span>
        </div>
      )}
      {(card.spent_amount != null || card.remaining != null) && (
        <div className="bc-gc-audit muted sm">
          spent {money(card.spent_amount)} · {money(card.remaining)} left
        </div>
      )}
      {err && <div className="error sm">{err}</div>}
    </li>
  );
}

export function BuyCartGiftCards({ cart, role, canIssue, isBuyer, onChanged, onSignOut }) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [balance, setBalance] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [viewing, setViewing] = useState(null); // { index, url }
  const [blobs, setBlobs] = useState({});

  const cards = cart.giftCards || [];
  const live = cards.filter((c) => !c.voided_at);
  const images = (cart.files || []).filter((f) => f.kind === 'gift_card');
  const target = Number(cart.approved_amount) || 0;
  const total = Number(cart.gc_total) || 0;
  const short = Math.max(0, Math.round((target - total) * 100) / 100);
  const canAdd = canIssue && ['approved', 'funded'].includes(cart.status);
  // A card is only readable by the desk that issued it and the buyer who has to spend
  // it — and the buyer only once it has actually been released to them.
  const canReveal = canIssue || (isBuyer && ['funded', 'receipted', 'audited', 'closed'].includes(cart.status));

  async function addCard(e) {
    e.preventDefault();
    setBusy('add'); setErr('');
    try {
      await api.cartAddGiftCard(cart.id, { code, pin, balance, label });
      setCode(''); setPin(''); setBalance(''); setLabel('');
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function fund() {
    setBusy('fund'); setErr('');
    try { await api.cartFund(cart.id); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function upload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('upload'); setErr('');
    try {
      const { uploadUrl, key } = await api.cartFileSign(cart.id, 'gift_card', file.type);
      const put = await fetch(uploadUrl, { method: 'PUT', body: file });
      if (!put.ok) throw new Error('The upload did not go through. Try again.');
      await api.cartFileAttach({
        cartId: cart.id, kind: 'gift_card', key, name: file.name,
        contentType: file.type, sizeBytes: file.size,
      });
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  // The bytes are proxied and authorised, so there is no `src` to hand an <img>: fetch
  // the blob and hold an object URL for as long as the viewer is open. Cached per file
  // so paging back and forth doesn't re-download.
  async function openImage(idx) {
    const f = images[idx];
    if (!f) return;
    if (blobs[f.id]) { setViewing({ index: idx, url: blobs[f.id] }); return; }
    setBusy('img'); setErr('');
    try {
      const { blob } = await api.cartFileBlob(cart.id, f.id);
      const url = URL.createObjectURL(blob);
      setBlobs((b) => ({ ...b, [f.id]: url }));
      setViewing({ index: idx, url });
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function download(f) {
    setErr('');
    try {
      const { blob, filename } = await api.cartFileDownload(cart.id, f.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || f.name || 'gift-card';
      document.body.appendChild(a); a.click(); a.remove();
      // Revoke on the next tick — revoking synchronously can beat the download in
      // Safari and hand the user an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
  }

  return (
    <section className="card bc-cards">
      <h3 className="bc-h">Gift cards</h3>

      <div className="bc-fund">
        <div className="bc-fund-nums">
          <span><b>{money(total)}</b> on {live.length} card{live.length === 1 ? '' : 's'}</span>
          <span className="muted">against <b>{money(target)}</b> approved</span>
          {short > 0
            ? <span className="bc-short">{money(short)} short</span>
            : target > 0 && <span className="bc-covered">covered</span>}
        </div>
        {/* The one hole in funding at sticker price, named where it matters rather than
            discovered at a till: with a small discount and a high tax rate the register
            asks for more than the shelf price adds up to. */}
        {cart.tillWarning && (
          <p className="bc-till-warn">
            At this buyer’s cost stack the till can charge more than the sticker — up to{' '}
            <b>{money(cart.tillWarning.amount)}</b> once {(((cart.tillWarning.factor - 1) * 100).toFixed(2))}% tax is added.
            Consider funding to that.
          </p>
        )}
        {canIssue && cart.status === 'approved' && (
          <button type="button" className="btn primary" disabled={busy === 'fund' || short > 0} onClick={fund}>
            {busy === 'fund' ? 'Releasing…' : 'Release to the buyer'}
          </button>
        )}
      </div>

      {cards.length > 0 && (
        <ul className="bc-gc-list">
          {cards.map((c) => (
            <GiftCardRow key={c.id} cart={cart} card={c} canReveal={canReveal}
              canVoid={canIssue && cart.status !== 'closed'} onChanged={onChanged} onSignOut={onSignOut} />
          ))}
        </ul>
      )}
      {!cards.length && <p className="muted sm">No cards recorded yet.</p>}

      {canAdd && (
        <form className="bc-gc-add" onSubmit={addCard}>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="Card number" autoComplete="off" spellCheck={false} />
          <input className="input bc-gc-pin-in" value={pin} onChange={(e) => setPin(e.target.value)}
            placeholder="PIN (optional)" autoComplete="off" spellCheck={false} />
          <PriceInput value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="Balance" />
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" />
          <button type="submit" className="btn" disabled={busy === 'add' || !code.trim() || !balance}>
            {busy === 'add' ? 'Saving…' : 'Record card'}
          </button>
        </form>
      )}

      {/* Photos / PDFs of the cards. Some suppliers send an image and nothing else, and
          a picture of a card is as spendable as the digits — so it goes through the same
          authorised proxy, never a bucket URL. */}
      <div className="bc-gc-files">
        <div className="bc-gc-files-h">
          <span className="muted sm">{images.length ? `${images.length} card image${images.length === 1 ? '' : 's'}` : 'No card images'}</span>
          {canAdd && (
            <label className="btn sm ghost bc-upload">
              {busy === 'upload' ? 'Uploading…' : 'Add image / PDF'}
              <input type="file" accept="image/*,application/pdf" hidden onChange={upload} />
            </label>
          )}
        </div>
        {images.length > 0 && (
          <ul className="bc-file-list">
            {images.map((f, i) => (
              <li key={f.id}>
                <span className="bc-file-name">{f.name || `Card ${i + 1}`}</span>
                {/* A PDF has no viewer here — it downloads, which is what a PDF is for. */}
                {String(f.content_type).startsWith('image/')
                  ? <button type="button" className="btn sm ghost" disabled={!canReveal} onClick={() => openImage(i)}>View</button>
                  : null}
                <button type="button" className="btn sm ghost" disabled={!canReveal} onClick={() => download(f)}>Download</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {err && <div className="error mt">{err}</div>}

      {/* Left/right through the card photos — ImageZoomModal already binds the arrow
          keys and draws the ‹ › nav, so this is the same viewer the rest of the app
          uses rather than a second one that behaves differently. */}
      {viewing && (
        <ImageZoomModal
          url={viewing.url}
          label={images[viewing.index]?.name || `Card ${viewing.index + 1} of ${images.length}`}
          onClose={() => setViewing(null)}
          onPrev={viewing.index > 0 ? () => openImage(viewing.index - 1) : undefined}
          onNext={viewing.index < images.length - 1 ? () => openImage(viewing.index + 1) : undefined}
        />
      )}
    </section>
  );
}
