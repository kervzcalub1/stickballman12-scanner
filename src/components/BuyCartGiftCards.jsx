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
import { PriceInput, CopyText, ImageZoomModal, FormModal } from './common.jsx';
import { cardsIssuable, cardsRefusedBecause, cardsAfterPurchase, fundingBreakdown } from '../lib/buycartRules.js';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

// One card. Collapsed to `•••• 4821 · $200.00`; the code appears only after a tap, and
// hides itself again when the panel is closed.
function GiftCardRow({ cart, card, canReveal, canVoid, onChanged, onSignOut }) {
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);
  const [voiding, setVoiding] = useState(false);
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

  async function voidIt({ reason }) {
    try { await api.cartVoidGiftCard(cart.id, card.id, reason.trim()); setVoiding(false); onChanged(); }
    catch (e) { if (e.unauthorized) return onSignOut(); throw e; }
  }

  return (
    <li className={`bc-gc ${card.voided_at ? 'voided' : ''}`}>
      {voiding && (
        <FormModal
          title={`Withdraw card •••• ${card.code_last4 || '????'}`}
          message="The card stays on the record and drops out of the funded total. It is never deleted."
          submitLabel="Withdraw it" danger
          onClose={() => setVoiding(false)}
          onSubmit={voidIt}
          fields={[{ name: 'reason', label: 'Why is this card being withdrawn?', type: 'textarea', required: true,
            placeholder: 'e.g. Card declined at the till — replaced with a new one' }]} />
      )}
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
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => setVoiding(true)}>Withdraw</button>
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

export function BuyCartGiftCards({ cart, role, canIssue, isBuyer, canAudit, onChanged, onSignOut }) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [balance, setBalance] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [viewing, setViewing] = useState(null); // { index, url }
  const [blobs, setBlobs] = useState({});
  // A machine reading waiting for a person: one file's ({ file, cards, source }), or every
  // file's ({ file: null, files: n, cards }) with each row naming where it came from.
  const [reading, setReading] = useState(null);
  const [uploading, setUploading] = useState(null); // { done, total }

  // The auditor's personal cards aren't the desk's: they live on the audit.
  const cards = (cart.giftCards || []).filter((c) => !c.personal);
  const live = cards.filter((c) => !c.voided_at);
  // Only people who can open them (`canOpenCardFiles`): some replies still list them for other staff.
  const images = canIssue || canAudit ? (cart.files || []).filter((f) => f.kind === 'gift_card') : [];
  // What the cards must carry: the shelf price of the approved pairs + the declared tax
  // (`funding_target`, computed server-side). Tips and shipping are not on the cards.
  const { shelf, tax: fundTax, target, pct: fundPct } = fundingBreakdown(cart);
  const total = Number(cart.gc_total) || 0;
  const short = Math.max(0, Math.round((target - total) * 100) / 100);
  // Only against a list the buyer has CLOSED, with every line decided — the same rule
  // the endpoint enforces, so the form never leads to a 409.
  const canAdd = canIssue && cardsIssuable(cart);
  // Uploading a card image and READING it are preparation, not issuing: the desk can
  // file what cardwell sent while the buyer is still adding. Recording stays gated.
  const canPrep = canIssue && !['closed', 'cancelled', 'written_off'].includes(cart.status);
  const whyNot = canIssue && !canAdd && !['closed', 'cancelled', 'written_off', 'receipted', 'audited'].includes(cart.status)
    ? cardsRefusedBecause(cart) : null;
  // A card is only readable by the desk that issued it and the buyer who has to spend
  // it — and the buyer only once it has actually been released to them.
  const released = ['funded', 'receipted', 'audited', 'closed'].includes(cart.status);
  const canReveal = canIssue || (isBuyer && released);
  // The auditor checks the spend against the cards, so they may download them once released.
  const canDownload = canReveal || (canAudit && released);
  // Two taps to delete a file. A recorded card stays recorded.
  const [confirming, setConfirming] = useState(null);
  async function removeFile(f) {
    setBusy(`rm${f.id}`); setErr('');
    try {
      await api.cartFileDelete(cart.id, f.id);
      setConfirming(null);
      setReading((r) => (r?.file?.id === f.id ? null : r));
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

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

  // One file or many: pictures, PDFs, CSVs or Cardwell's ZIP. The server starts reading each as
  // it lands (file-attach), so there is nothing to press per file.
  async function upload(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy('upload'); setErr('');
    let done = 0;
    setUploading({ done, total: files.length });
    try {
      for (const file of files) {
        // A CSV arrives as text/csv, application/vnd.ms-excel (Windows) or no type at all,
        // depending on the machine, and a ZIP as application/zip or x-zip-compressed — the
        // name is the one thing they agree on.
        const type = /\.csv$/i.test(file.name || '') ? 'text/csv'
          : /\.zip$/i.test(file.name || '') ? 'application/zip' : file.type;
        const { uploadUrl, key } = await api.cartFileSign(cart.id, 'gift_card', type);
        const put = await fetch(uploadUrl, { method: 'PUT', body: file });
        if (!put.ok) throw new Error('The upload did not go through. Try again.');
        await api.cartFileAttach({
          cartId: cart.id, kind: 'gift_card', key, name: file.name,
          contentType: type, sizeBytes: file.size,
        });
        done++;
        setUploading({ done, total: files.length });
      }
      onChanged();
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      setErr(files.length > 1 ? `${done} of ${files.length} uploaded. ${ex.message}` : ex.message);
      if (done) onChanged();
    } finally { setBusy(''); setUploading(null); }
  }

  // The bytes are proxied and authorised, so there is no `src` to hand an <img>: fetch
  // the blob and hold an object URL for as long as the viewer is open. Cached per file
  // so paging back and forth doesn't re-download.
  const pictures = images.filter((f) => String(f.content_type).startsWith('image/'));

  async function blobFor(f) {
    if (blobs[f.id]) return blobs[f.id];
    const { blob } = await api.cartFileBlob(cart.id, f.id);
    const url = URL.createObjectURL(blob);
    setBlobs((b) => ({ ...b, [f.id]: url }));
    return url;
  }

  // The viewer walks the IMAGES only (a PDF has no picture to page to), and warms the
  // rest in the background so the thumbnail strip fills in as they land.
  async function openImage(idx) {
    const f = pictures[idx];
    if (!f) return;
    setBusy('img'); setErr('');
    try {
      const url = await blobFor(f);
      setViewing({ index: idx, url });
      pictures.filter((o) => o.id !== f.id && !blobs[o.id]).forEach((o) => blobFor(o).catch(() => {}));
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  // READ THE CARDS OFF THE FILE. The numbers come back for review, never recorded here.
  async function readFile(f) {
    setBusy(`read${f.id}`); setErr(''); setReading(null);
    try {
      const r = await api.cartGiftCardRead(cart.id, f.id);
      if (!r.cards?.length) {
        setErr(r.mangled
          ? `The card numbers in “${f.name || 'that file'}” were turned into numbers like 6.06E+18 by Excel — the digits are gone. Ask for the original CSV, or re-export with the card number column formatted as Text.`
          : `Nothing on “${f.name || 'that file'}” read as a card number. Try a sharper picture with the card filling the frame, or type it in. You can delete this file if it is no use.`);
        return;
      }
      setReading({
        file: f, source: r.source, mangled: r.mangled || 0, unread: r.unread || 0,
        cards: r.cards.map((c) => ({ ...c, balance: c.balance == null ? '' : String(c.balance), ok: !c.already })),
      });
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  // What the server has done with the files so far.
  const isZip = (f) => /zip/.test(String(f.content_type || '')) || /\.zip$/i.test(f.name || '');
  const readWaiting = images.filter((f) => ['queued', 'reading'].includes(f.read_status));
  const readDone = images.filter((f) => f.read_status === 'done');
  const readyCards = readDone.reduce((n, f) => n + Number(f.read_count || 0), 0);
  const missed = images.filter((f) => f.read_status === 'failed' || (f.read_status === 'done' && !Number(f.read_count)));
  const notRead = images.filter((f) => !f.read_status || f.read_status === 'failed');

  async function readAll() {
    setBusy('readall'); setErr('');
    try { await api.cartCardReads(cart.id, 'queue'); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  async function stopReading() {
    setBusy('stop'); setErr('');
    try { await api.cartCardReads(cart.id, 'cancel'); onChanged(); }
    catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  // Opening the digits is a deliberate press, and the server writes who pressed it. They are
  // never fetched on load: a cart page gets opened over someone's shoulder.
  async function reviewAll() {
    setBusy('review'); setErr(''); setReading(null);
    try {
      const r = await api.cartCardReads(cart.id, 'results');
      setReading({
        file: null, files: r.files, source: 'all', mangled: r.mangled || 0, unread: r.unread || 0,
        cards: r.cards.map((c) => ({ ...c, balance: c.balance == null ? '' : String(c.balance), ok: !c.already && !c.conflict })),
      });
      onChanged();
    } catch (ex) { if (ex.unauthorized) return onSignOut(); setErr(ex.message); }
    finally { setBusy(''); }
  }

  const setRead = (i, patch) => setReading((r) => ({ ...r, cards: r.cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  // Every ticked row in ONE call, recorded in order on the server by the same code a pasted
  // card goes through. `recorded` says how many landed, so a failure partway keeps the rest on
  // screen and pressing again can't record the first ones twice.
  async function recordRead() {
    const rows = reading.cards.filter((c) => c.ok);
    setBusy('record'); setErr('');
    try {
      const out = await api.cartAddGiftCards(cart.id, rows.map((c) => ({
        code: c.number, pin: c.pin || '', balance: c.balance, retailer: c.retailer || '',
        label: c.fileName || reading.file?.name || '',
      })));
      const landed = new Set(rows.slice(0, out.recorded).map((c) => c.number));
      setReading((r) => ({ ...r, cards: r.cards.map((x) => (landed.has(x.number) ? { ...x, saved: true, ok: false } : x)) }));
      if (out.error) { setErr(out.error); onChanged(); return; }
      // The digits now live on the cards, so the stored readings go. A row left unticked can be
      // read again from its file.
      if (!reading.file) await api.cartCardReads(cart.id, 'clear');
      setReading(null);
      onChanged();
    } catch (ex) {
      if (ex.unauthorized) return onSignOut();
      setErr(ex.message);
    } finally { setBusy(''); }
  }

  // Every live card as ONE PDF: balance, number, PIN and the card's own picture, a page
  // a card — the CSV's numbers and the images' barcodes put back together for the till.
  // The server writes the trail row before it decrypts anything.
  async function downloadAll() {
    setBusy('pdf'); setErr('');
    try {
      const { blob, filename } = await api.cartGiftCardsPdf(cart.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || `${cart.cart_code || 'request'}-gift-cards.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onChanged();
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
          <span className="muted">
            against <b>{money(target)}</b> needed
            {fundTax > 0 && <> ({money(shelf)} shelf + {money(fundTax)} tax{fundPct != null ? ` at ${fundPct}%` : ''})</>}
          </span>
          {short > 0
            ? <span className="bc-short">{money(short)} short</span>
            : target > 0 && <span className="bc-covered">covered</span>}
        </div>
        <p className="muted xs">Gift cards cover the shelf price and sales tax only. Tips and shipping are not on the cards.</p>
        {/* Why no card can be recorded yet, in the endpoint's own words — "the buyer is
            still adding" is the one the desk most needs, because the total is not final. */}
        {whyNot && <p className="bc-till-warn">{whyNot}</p>}
        {canIssue && cart.status === 'approved' && canAdd && (
          <button type="button" className="btn primary" disabled={busy === 'fund' || short > 0} onClick={fund}>
            {busy === 'fund' ? 'Releasing…' : 'Release to the buyer'}
          </button>
        )}
        {/* A re-opened request that came back short: the cards already out are the
            buyer's to spend; this says how much more to record once the list is closed
            and the new lines decided. */}
        {canIssue && cart.status === 'funded' && short > 0 && (
          <p className="muted sm">Released {money(total)} so far — {money(short)} more to record for the pairs approved since.</p>
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
      {canDownload && live.length > 0 && (
        <div className="bc-gc-pdf">
          <button type="button" className="btn sm" disabled={busy === 'pdf'} onClick={downloadAll}
            title="One PDF, a page a card: balance, number, PIN and the card's picture. Recorded against your name.">
            {busy === 'pdf' ? 'Building the PDF…' : `Download all ${live.length} card${live.length === 1 ? '' : 's'} (PDF)`}
          </button>
          <span className="muted xs">Balance, number, PIN and the card’s picture on one page each · recorded against your name</span>
        </div>
      )}

      {/* Past the till, a card recorded here is one the buyer already spent — the receipt
          came to more than the cards on file. Say so, because it is a different act from
          handing a card over, and say what it sets off. */}
      {canAdd && cardsAfterPurchase(cart) && (
        <p className="muted sm">
          The receipt is in. Record a card here only if the buyer spent one that isn’t listed
          above — the auditor then records what it was spent.
        </p>
      )}
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

      {/* Photos / PDFs of the cards, for the desk. The supplier never sees this: the server
          sends them no files, and they get the recorded cards as the one PDF above. */}
      {!isBuyer && <div className="bc-gc-files">
        <div className="bc-gc-files-h">
          <span className="muted sm">{images.length ? `${images.length} card file${images.length === 1 ? '' : 's'}` : 'No card files'}</span>
          {canPrep && (
            <label className="btn sm ghost bc-upload">
              {uploading ? `Uploading ${Math.min(uploading.done + 1, uploading.total)} of ${uploading.total}…` : 'Add images / PDF / CSV / ZIP'}
              <input type="file" multiple accept="image/*,application/pdf,.csv,text/csv,.zip,application/zip" hidden onChange={upload} />
            </label>
          )}
        </div>

        {canPrep && !images.length && (
          <p className="muted xs">From Cardwell: upload the CSV with the ZIP. The CSV has each card’s balance, the ZIP has its barcode picture.</p>
        )}

        {/* The server reads files as they land. The page only shows how far it has got, and the
            digits don't come to the screen until someone presses Review. */}
        {canIssue && images.length > 0 && (readWaiting.length > 0 || readyCards > 0 || missed.length > 0 || notRead.length > 0) && (
          <div className="bc-gc-bulk">
            {readWaiting.length > 0 && (
              <div className="bc-gc-bulk-row">
                <span className="sm">
                  <b>Reading {readDone.length + 1} of {readDone.length + readWaiting.length} files…</b>
                  <span className="muted"> You can leave this page; it carries on.</span>
                </span>
                <button type="button" className="btn sm ghost" disabled={busy === 'stop'} onClick={stopReading}>Stop</button>
              </div>
            )}
            {readyCards > 0 && (
              <div className="bc-gc-bulk-row">
                <button type="button" className="btn primary sm" disabled={busy === 'review' || !!reading} onClick={reviewAll}>
                  {busy === 'review' ? 'Opening…' : `Review the ${readyCards} card${readyCards === 1 ? '' : 's'} read`}
                </button>
                <span className="muted xs">Opening them is recorded against your name. Nothing is on the request until you record it.</span>
              </div>
            )}
            {!readWaiting.length && notRead.length > 0 && canPrep && (
              <div className="bc-gc-bulk-row">
                <button type="button" className="btn sm" disabled={busy === 'readall'} onClick={readAll}>
                  {busy === 'readall' ? 'Starting…' : `Read ${notRead.length} file${notRead.length === 1 ? '' : 's'} not read yet`}
                </button>
              </div>
            )}
            {!readWaiting.length && missed.length > 0 && (
              <p className="bc-short xs">
                Nothing read from {missed.length} file{missed.length === 1 ? '' : 's'}: {missed.slice(0, 5).map((f) => f.name || 'unnamed').join(', ')}{missed.length > 5 ? ` and ${missed.length - 5} more` : ''}. Open {missed.length === 1 ? 'it' : 'them'} and type the card in.
              </p>
            )}
          </div>
        )}

        {images.length > 0 && (
          <details className="bc-gc-files-list" open={images.length <= 8}>
          <summary className="muted xs">Show the files</summary>
          <ul className="bc-file-list">
            {images.map((f, i) => {
              const isImg = String(f.content_type).startsWith('image/');
              return (
              <li key={f.id}>
                <span className="bc-file-name">{f.name || `Card ${i + 1}`}</span>
                {['queued', 'reading'].includes(f.read_status) && <span className="muted xs">{isZip(f) ? 'Unpacking…' : f.read_status === 'reading' ? 'Reading…' : 'Waiting…'}</span>}
                {f.read_status === 'done' && (Number(f.read_count) > 0
                  ? <span className="bc-covered xs">{f.read_count} card{Number(f.read_count) === 1 ? '' : 's'} read{Number(f.read_unread) > 0 ? `, ${f.read_unread} page${Number(f.read_unread) === 1 ? '' : 's'} not` : ''}</span>
                  : <span className="bc-short xs">Nothing read</span>)}
                {f.read_status === 'failed' && <span className="bc-short xs">{f.read_error || 'Could not be read'}</span>}
                {/* Read the numbers off it — a card face, a screenshot, or a table of
                    cards — into a review table below. Nothing is recorded until ticked. */}
                {canPrep && !isZip(f) && (
                  <button type="button" className="btn sm" disabled={busy === `read${f.id}` || busy === 'record'}
                    title="Read the card numbers, PINs and balances off this file for review"
                    onClick={() => readFile(f)}>{busy === `read${f.id}` ? 'Reading…' : 'Read the cards'}</button>
                )}
                {/* A PDF has no viewer here — it downloads, which is what a PDF is for. */}
                {isImg
                  ? <button type="button" className="btn sm ghost" disabled={!canDownload} onClick={() => openImage(pictures.findIndex((p) => p.id === f.id))}>View</button>
                  : null}
                <button type="button" className="btn sm ghost" disabled={!canDownload} onClick={() => download(f)}>Download</button>
                {canPrep && (confirming === f.id
                  ? (
                    <>
                      <span className="muted sm">Delete it? Recorded cards stay.</span>
                      <button type="button" className="btn sm danger" disabled={busy === `rm${f.id}`} onClick={() => removeFile(f)}>
                        {busy === `rm${f.id}` ? 'Deleting…' : 'Delete'}
                      </button>
                      <button type="button" className="btn sm ghost" onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  )
                  : <button type="button" className="btn sm ghost" onClick={() => setConfirming(f.id)}>Delete</button>)}
              </li>
              );
            })}
          </ul>
          </details>
        )}
      </div>}

      {/* The reading, for a person to check. Rows tint amber until ticked, the same rule
          the receipt table follows: a plausible wrong digit is a card that cannot be
          spent, and only eyes catch it. A row whose last four match a card already on
          the request starts UNTICKED — it is usually the same card read twice. */}
      {reading && (
        <div className="bc-gc-read">
          <div className="bc-gc-read-h">
            <b>{reading.cards.length} card{reading.cards.length === 1 ? '' : 's'} read from {reading.file ? `“${reading.file.name || 'file'}”` : `${reading.files} file${reading.files === 1 ? '' : 's'}`}</b>
            <span className="muted xs">{reading.source === 'all' ? 'on this server' : reading.source === 'pdf' ? 'from the PDF text' : reading.source === 'csv' ? 'from the CSV' : 'off the card, read twice'} · check every digit, fill any blank balance, tick, then record</span>
            {reading.unread > 0 && (
              <span className="bc-short xs">{reading.unread} page{reading.unread === 1 ? '' : 's'} could not be read — type {reading.unread === 1 ? 'that card' : 'those cards'} in.</span>
            )}
            {reading.mangled > 0 && (
              <span className="bc-short xs">{reading.mangled} row{reading.mangled === 1 ? '' : 's'} skipped — Excel turned the card number into 6.06E+18 and the digits are gone. Get the original CSV for {reading.mangled === 1 ? 'it' : 'them'}.</span>
            )}
            <span className="bc-gc-read-fill">
              <PriceInput placeholder="Set every blank balance"
                aria-label="Set every blank balance"
                // `filled` rows follow what's typed. Filling only blank rows stopped at the first
                // keystroke: typing 200 left every row at $2.
                onChange={(e) => { const v = e.target.value; setReading((r) => ({ ...r, cards: r.cards.map((c) => ((c.balance === '' || c.filled) && !c.saved ? { ...c, balance: v, filled: v !== '' } : c)) })); }} />
            </span>
          </div>
          <ul className="bc-gc-read-list">
            {reading.cards.map((c, i) => (
              <li key={c.number} className={c.saved ? 'saved' : c.ok ? 'ok' : 'pending'}>
                <label className="bc-gc-read-tick">
                  <input type="checkbox" checked={!!c.ok} disabled={c.saved} onChange={(e) => setRead(i, { ok: e.target.checked })} aria-label={`Record card ending ${c.number.slice(-4)}`} />
                </label>
                <input className="input bc-gc-read-num" value={c.number} inputMode="numeric" disabled={c.saved}
                  onChange={(e) => setRead(i, { number: e.target.value.replace(/\D/g, '') })} aria-label="Card number" />
                <input className="input bc-gc-read-pin" value={c.pin || ''} placeholder="PIN" inputMode="numeric" disabled={c.saved}
                  onChange={(e) => setRead(i, { pin: e.target.value.replace(/\D/g, '') })} aria-label="PIN" />
                <PriceInput value={c.balance} placeholder="Balance" disabled={c.saved}
                  onChange={(e) => setRead(i, { balance: e.target.value, filled: false })} />
                {c.saved ? <span className="bc-covered xs">recorded</span>
                  : c.conflict ? <span className="bc-short xs" title="This card is in two files with a different PIN or balance. Check it against the picture.">files disagree — check it</span>
                  : c.already ? <span className="bc-short xs" title="A card ending in these four digits is already on this request">already on this request?</span>
                    : c.retailer ? <span className="muted xs">{c.retailer}</span> : null}
              </li>
            ))}
          </ul>
          <div className="bc-gc-read-foot">
            <button type="button" className="btn ghost sm" disabled={busy === 'record'} onClick={() => setReading(null)}>{reading.file ? 'Discard' : 'Close'}</button>
            {(() => {
              const ticked = reading.cards.filter((c) => c.ok);
              const blank = ticked.filter((c) => !(Number(c.balance) > 0) || c.number.length < 8).length;
              return (
                <button type="button" className="btn primary sm" disabled={busy === 'record' || !ticked.length || blank > 0 || !canAdd}
                  title={!canAdd ? (cardsRefusedBecause(cart) || '') : blank ? `${blank} ticked card${blank === 1 ? ' has' : 's have'} no balance or a short number` : ''}
                  onClick={recordRead}>
                  {busy === 'record' ? 'Recording…' : `Record ${ticked.length} card${ticked.length === 1 ? '' : 's'}`}
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {err && <div className="error mt">{err}</div>}

      {/* Left/right through the card photos — ImageZoomModal already binds the arrow
          keys and draws the ‹ › nav, so this is the same viewer the rest of the app
          uses rather than a second one that behaves differently. */}
      {viewing && (
        <ImageZoomModal
          url={viewing.url}
          label={`${pictures[viewing.index]?.name || `Card ${viewing.index + 1}`} · ${viewing.index + 1} of ${pictures.length}`}
          onClose={() => setViewing(null)}
          onPrev={viewing.index > 0 ? () => openImage(viewing.index - 1) : undefined}
          onNext={viewing.index < pictures.length - 1 ? () => openImage(viewing.index + 1) : undefined}
          thumbs={pictures.map((f) => ({ url: blobs[f.id] || null, label: f.name }))}
          index={viewing.index}
          onSelect={openImage}
          onDownload={() => download(pictures[viewing.index])}
        />
      )}
    </section>
  );
}
