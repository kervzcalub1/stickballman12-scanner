// Schematics for the SOP pages. Hand-laid inline SVG (plus one HTML matrix) so a
// diagram costs no network request, scales to any phone, and inherits the app's
// theme.
//
// Colour comes from CSS classes in styles.css (.sd-*), never from `fill=` /
// `stroke=` attributes: CSS custom properties do not resolve inside SVG
// presentation attributes on the older iPhones the warehouse runs, so
// `fill="var(--panel-2)"` would render as nothing at all.
//
// Geometry lives in a 0 0 W H viewBox and scales to the container width. Boxes
// are laid out by hand — these are ~10 fixed diagrams, and a layout engine would
// cost more than it saves.
import React from 'react';

const BW = 138;   // default box width
const BH = 54;    // default box height

// --- primitives -------------------------------------------------------------

// A node. `tone` picks the palette (see .sd-box[data-tone] in styles.css);
// `sub` is the small second line, `note` renders under the box as a caption.
function Box({ x, y, w = BW, h = BH, title, sub, note, tone = 'default', rx = 10 }) {
  const cx = x + w / 2;
  return (
    <g>
      <rect className="sd-box" data-tone={tone} x={x} y={y} width={w} height={h} rx={rx} />
      <text className="sd-title" x={cx} y={sub ? y + h / 2 - 3 : y + h / 2 + 4} textAnchor="middle">{title}</text>
      {sub && <text className="sd-sub" x={cx} y={y + h / 2 + 13} textAnchor="middle">{sub}</text>}
      {note && <text className="sd-note" x={cx} y={y + h + 15} textAnchor="middle">{note}</text>}
    </g>
  );
}

// A decision diamond. Width/height are the full extents, not radii.
function Diamond({ x, y, w = 132, h = 68, title, tone = 'warn' }) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return (
    <g>
      <polygon className="sd-box" data-tone={tone} points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`} />
      <text className="sd-title" x={cx} y={cy + 4} textAnchor="middle">{title}</text>
    </g>
  );
}

// Straight arrow with an optional label sitting on its midpoint.
function Arrow({ x1, y1, x2, y2, label, tone = 'default', dashed }) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line className={`sd-line${dashed ? ' sd-dash' : ''}`} data-tone={tone} x1={x1} y1={y1} x2={x2} y2={y2} markerEnd={`url(#sd-arrow-${tone})`} />
      {label && (
        <>
          <text className="sd-edge sd-edge-bg" x={mx} y={my - 6} textAnchor="middle">{label}</text>
          <text className="sd-edge" x={mx} y={my - 6} textAnchor="middle">{label}</text>
        </>
      )}
    </g>
  );
}

// Elbow arrow: horizontal, then vertical, then horizontal (`midX` is the turn).
function Elbow({ x1, y1, x2, y2, midX, label, tone = 'default', dashed }) {
  const m = midX == null ? (x1 + x2) / 2 : midX;
  return (
    <g>
      <path className={`sd-line${dashed ? ' sd-dash' : ''}`} data-tone={tone} d={`M ${x1} ${y1} H ${m} V ${y2} H ${x2}`} markerEnd={`url(#sd-arrow-${tone})`} fill="none" />
      {label && (
        <>
          <text className="sd-edge sd-edge-bg" x={m} y={(y1 + y2) / 2} textAnchor="middle">{label}</text>
          <text className="sd-edge" x={m} y={(y1 + y2) / 2} textAnchor="middle">{label}</text>
        </>
      )}
    </g>
  );
}

// A labelled swimlane band (used by the purchase-order diagram).
function Lane({ x, y, w, h, label }) {
  return (
    <g>
      <rect className="sd-lane" x={x} y={y} width={w} height={h} rx={10} />
      <text className="sd-lane-label" x={x + 10} y={y + 18}>{label}</text>
    </g>
  );
}

// One arrowhead marker per tone — markers cannot inherit the line's colour.
const TONES = ['default', 'accent', 'ok', 'warn', 'bad', 'muted'];
function Defs() {
  return (
    <defs>
      {TONES.map((t) => (
        <marker key={t} id={`sd-arrow-${t}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path className="sd-head" data-tone={t} d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      ))}
    </defs>
  );
}

function Svg({ w, h, children, title }) {
  return (
    <svg className="sd-svg" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} preserveAspectRatio="xMidYMid meet">
      <Defs />
      {children}
    </svg>
  );
}

// --- diagrams ---------------------------------------------------------------

// Receiving: the four wizard steps and what each one is responsible for.
function ReceivingWizard() {
  const y = 30;
  const w = 132;
  const gap = 30;
  const xs = [10, 10 + (w + gap), 10 + 2 * (w + gap), 10 + 3 * (w + gap), 10 + 4 * (w + gap)];
  const labels = [
    ['1 · Shipment', 'supplier · tracking', 'both required'],
    ['2 · Items', 'scan UPC / SKU', 'per size, With Box'],
    ['3 · Review', 'qty ± · defects', 'per pair, per VIN'],
    ['4 · Issues', 'shipment-level', 'ripped · short · stolen'],
    ['Finish', 'VINs minted', 'labels printable'],
  ];
  return (
    <Svg w={800} h={130} title="The four receiving steps">
      {xs.map((x, i) => (
        <Box key={i} x={x} y={y} w={w} title={labels[i][0]} sub={labels[i][1]} note={labels[i][2]} tone={i === 4 ? 'ok' : 'default'} />
      ))}
      {xs.slice(0, 4).map((x, i) => (
        <Arrow key={i} x1={x + w} y1={y + BH / 2} x2={xs[i + 1] - 4} y2={y + BH / 2} tone="muted" />
      ))}
      <text className="sd-caption" x={400} y={16} textAnchor="middle">Rescale runs steps 1 and 2 only · In-store runs all four with a shipment-less step 1</text>
    </Svg>
  );
}

// Multi-box: boxes are independent and out-of-order; the batch closes last.
function MultiBox() {
  return (
    <Svg w={800} h={280} title="A multi-box batch">
      <Box x={20} y={110} w={150} title="Open batch" sub="created lazily" note="on the first box commit" tone="accent" />
      {[0, 1, 2].map((i) => {
        const y = 20 + i * 80;
        return (
          <g key={i}>
            <Box x={250} y={y} w={150} h={48} title={`Box ${i + 1}`} sub="its own tracking #" />
            <Box x={450} y={y} w={140} h={48} title="Add items" sub="items → review → submit" />
            <Arrow x1={400} y1={y + 24} x2={446} y2={y + 24} tone="muted" />
            <Elbow x1={170} y1={137} x2={246} y2={y + 24} midX={210} tone="muted" />
            <Elbow x1={590} y1={y + 24} x2={646} y2={137} midX={620} tone="muted" />
          </g>
        );
      })}
      <Box x={650} y={110} w={130} title="Finish batch" sub="or auto-completes" note="when received = expected" tone="ok" />
      <text className="sd-caption" x={400} y={262} textAnchor="middle">Boxes are scanned in ANY order and keep their own number · a box with a tracking # but no items still shows, with a red 0</text>
    </Svg>
  );
}

// Purchase orders end to end, across the three desks that touch them.
function PoFlow() {
  const laneH = 92;
  const ys = [26, 26 + laneH + 10, 26 + 2 * (laneH + 10)];
  const by = (i) => ys[i] + 26;
  return (
    <Svg w={800} h={340} title="Purchase order, end to end">
      <Lane x={8} y={ys[0]} w={784} h={laneH} label="PH TEAM" />
      <Lane x={8} y={ys[1]} w={784} h={laneH} label="SUPPLIER" />
      <Lane x={8} y={ys[2]} w={784} h={laneH} label="WAREHOUSE" />

      <Box x={30} y={by(0)} w={150} h={48} title="Open the order" sub="labels + tracking" tone="accent" />
      <Box x={620} y={by(0)} w={150} h={48} title="Resolve & note" sub="refund / reship" tone="warn" />

      <Box x={215} y={by(1)} w={130} h={48} title="Scan out" sub="per label" />
      <Box x={360} y={by(1)} w={110} h={48} title="Close box" sub="packed" />
      <Box x={485} y={by(1)} w={110} h={48} title="Ship" sub="courier has it" />

      <Box x={215} y={by(2)} w={165} h={48} title="Receive against PO" sub="scan the box in" />
      <Box x={400} y={by(2)} w={165} h={48} title="Reconcile" sub="expected vs received" />
      <Box x={585} y={by(2)} w={185} h={48} title="Clean → closes itself" sub="short/over → stays queued" tone="ok" />

      <Elbow x1={105} y1={by(0) + 48} x2={215} y2={by(1) + 24} midX={160} tone="muted" label="draft" />
      <Arrow x1={345} y1={by(1) + 24} x2={356} y2={by(1) + 24} tone="muted" />
      <Arrow x1={470} y1={by(1) + 24} x2={481} y2={by(1) + 24} tone="muted" />
      <Elbow x1={540} y1={by(1) + 48} x2={297} y2={by(2)} midX={560} tone="muted" label="in transit" />
      <Arrow x1={380} y1={by(2) + 24} x2={396} y2={by(2) + 24} tone="muted" />
      <Arrow x1={565} y1={by(2) + 24} x2={581} y2={by(2) + 24} tone="muted" />
      <Elbow x1={695} y1={by(2)} x2={695} y2={by(0) + 48} midX={695} tone="bad" label="discrepancy" />
      <text className="sd-caption" x={400} y={330} textAnchor="middle">The warehouse may receive against a DRAFT order — boxes routinely arrive before every label has been shipped</text>
    </Svg>
  );
}

// What each reconciliation chip actually means.
function PoReconcileStates() {
  const rows = [
    ['Receiving', 'muted', 'Boxes arrived, intake still running. Nothing to decide yet.'],
    ['Boxes still out', 'muted', 'Something is still sitting at the supplier.'],
    ['Matched · ready to close', 'ok', 'Counted and clean. Usually closes itself.'],
    ['Reconciled', 'ok', 'Counted, agreed, and frozen.'],
    ['N discrepancies', 'bad', 'Short, over or wrong SKU. Chase the supplier.'],
    ['Received blind', 'warn', 'No manifest was ever given. Rows read "Received", not "Not on PO".'],
  ];
  return (
    <Svg w={800} h={rows.length * 42 + 30} title="What each purchase-order chip means">
      {rows.map(([label, tone, meaning], i) => {
        const y = 14 + i * 42;
        return (
          <g key={label}>
            <rect className="sd-chip" data-tone={tone} x={10} y={y} width={196} height={30} rx={15} />
            <text className="sd-chip-text" x={108} y={y + 19} textAnchor="middle">{label}</text>
            <text className="sd-body" x={224} y={y + 19}>{meaning}</text>
          </g>
        );
      })}
    </Svg>
  );
}

// The four-step discrepancy checklist, and where it branches.
function PoResolution() {
  const y = 92;
  const w = 138;
  const xs = [14, 180, 346, 512];
  return (
    <Svg w={800} h={210} title="Discrepancy resolution">
      <Box x={xs[0]} y={y} w={w} title="1 · Contacted" sub="supplier raised" />
      <Box x={xs[1]} y={y} w={w} title="2 · Outcome" sub="refund / reship / write-off" tone="accent" />
      <Box x={xs[2]} y={y} w={w} title="3 · Reference" sub="agreed amount" note="skipped for a write-off" />
      <Box x={xs[3]} y={y} w={w} title="4 · Settled" sub="what actually arrived" note="short payment is flagged" tone="ok" />
      {[0, 1, 2].map((i) => <Arrow key={i} x1={xs[i] + w} y1={y + BH / 2} x2={xs[i + 1] - 4} y2={y + BH / 2} tone="muted" />)}

      <Box x={666} y={20} w={126} h={44} title="Note to supplier" sub="the ONLY thing they read" tone="warn" />
      <Box x={666} y={y} w={126} title="Internal thread" sub="the audit trail" note="every step posts here" tone="muted" />
      <Arrow x1={666} y1={42} x2={560} y2={42} tone="warn" dashed label="Send to supplier" />
      <Elbow x1={650} y1={y + BH / 2} x2={666} y2={y + BH / 2} midX={658} tone="muted" />

      <Box x={180} y={20} w={200} h={44} title="Replacement = a real label" sub="on this same order, carrying no manifest lines" tone="accent" />
      <Arrow x1={249} y1={64} x2={249} y2={y - 4} tone="muted" />
      <text className="sd-caption" x={400} y={196} textAnchor="middle">Every step can be undone · a reship reopens the order for receiving, and says so in the thread</text>
    </Svg>
  );
}

// The two rescale halves, and how they feed each other.
function RescaleLoop() {
  return (
    <Svg w={800} h={250} title="The rescale loop">
      <text className="sd-caption" x={205} y={16} textAnchor="middle">Warehouse rescales → PH re-lists</text>
      <Box x={20} y={30} w={160} h={50} title="Rescale Stock" sub="warehouse re-scans VINs" />
      <Box x={230} y={30} w={160} h={50} title="PH worklist" sub="marked for restock" tone="accent" />
      <Box x={230} y={110} w={160} h={50} title="Price & list" sub="II · AL · SX · SH" />
      <Box x={20} y={110} w={160} h={50} title="✓ Restocked" sub="back to normal stock" tone="ok" />
      <Arrow x1={180} y1={55} x2={226} y2={55} tone="muted" />
      <Arrow x1={310} y1={80} x2={310} y2={106} tone="muted" />
      <Arrow x1={230} y1={135} x2={184} y2={135} tone="muted" />

      <text className="sd-caption" x={600} y={16} textAnchor="middle">PH asks → warehouse counts</text>
      <Box x={430} y={30} w={160} h={50} title="Request rescale" sub="PH reports sizes + qty" tone="accent" />
      <Box x={640} y={30} w={150} h={50} title="Audit shelf" sub="warehouse counts" />
      <Box x={640} y={110} w={150} h={50} title="Reported vs actual" sub="red = mismatch" tone="warn" />
      <Box x={430} y={110} w={160} h={50} title="List against actual" sub="saved on the request" />
      <Arrow x1={590} y1={55} x2={636} y2={55} tone="muted" />
      <Arrow x1={715} y1={80} x2={715} y2={106} tone="muted" />
      <Arrow x1={640} y1={135} x2={594} y2={135} tone="muted" />

      <line className="sd-line sd-dash" data-tone="muted" x1={410} y1={24} x2={410} y2={170} />
      <text className="sd-caption" x={400} y={210} textAnchor="middle">A request counts a SKU — it does NOT flip inventory sync flags. Only the worklist does that.</text>
      <text className="sd-caption" x={400} y={228} textAnchor="middle">In-store pairs are refused at the rescale step, so they can never reach the PH worklist.</text>
    </Svg>
  );
}

// Statuses and the legal moves between them.
function StatusMachine() {
  return (
    <Svg w={800} h={280} title="Statuses and transitions">
      <Box x={20} y={30} w={150} title="Received" sub="intake commits" tone="muted" />
      <Box x={230} y={20} w={160} title="Needs shelf" sub="has its box" tone="accent" />
      <Box x={230} y={110} w={160} title="No box" sub="not sellable" tone="bad" />
      <Box x={460} y={20} w={150} title="In Stock · A2-04" sub="on a shelf" tone="ok" />
      <Box x={660} y={20} w={120} title="Pre-Sold" tone="default" />
      <Box x={460} y={120} w={150} title="Sold / Shipped" sub="TERMINAL" tone="bad" />
      <Box x={660} y={120} w={120} h={44} title="Returned" sub="Missing · Issue" tone="warn" />

      <Elbow x1={170} y1={47} x2={226} y2={47} midX={200} tone="muted" label="with box" />
      <Elbow x1={170} y1={57} x2={226} y2={137} midX={200} tone="bad" label="no box" />
      <Arrow x1={390} y1={47} x2={456} y2={47} tone="ok" label="shelve" />
      <Elbow x1={310} y1={110} x2={310} y2={78} midX={310} tone="ok" label="box found" />
      <Arrow x1={610} y1={47} x2={656} y2={47} tone="muted" />
      <Arrow x1={535} y1={74} x2={535} y2={116} tone="muted" label="sell / ship" />
      <Arrow x1={610} y1={142} x2={656} y2={142} tone="muted" dashed />

      <text className="sd-caption" x={400} y={210} textAnchor="middle">In Stock cannot be set by hand — picking it opens the Move-to-shelf scanner, because a pair that is in stock nowhere helps nobody.</text>
      <text className="sd-caption" x={400} y={230} textAnchor="middle">Sold and Shipped are terminal: no route back to an active status. Sold ⇄ Shipped is the only move left.</text>
      <text className="sd-caption" x={400} y={250} textAnchor="middle">Selling or shipping clears II · AL · SX · SH in the same action, and logs it as system-generated.</text>
    </Svg>
  );
}

// Why a shelve scan gets refused.
function PutawayDecision() {
  return (
    <Svg w={800} h={250} title="What happens when you shelve a pair">
      <Box x={16} y={92} w={140} title="Scan VIN" sub="onto a scanned shelf" tone="accent" />
      <Diamond x={190} y={84} w={150} h={72} title="Has its box?" />
      <Box x={390} y={30} w={160} title="In Stock" sub="at that shelf" tone="ok" />
      <Diamond x={380} y={132} w={170} h={72} title="Box found now?" />
      <Box x={600} y={110} w={180} h={46} title="With box + In Stock" sub="logged as box-found" tone="ok" />
      <Box x={600} y={176} w={180} h={46} title="REFUSED — stays No Box" sub="resolve in the No Box queue" tone="bad" />

      <Arrow x1={156} y1={119} x2={186} y2={119} tone="muted" />
      <Elbow x1={265} y1={84} x2={386} y2={56} midX={330} tone="ok" label="yes" />
      <Elbow x1={265} y1={156} x2={380} y2={168} midX={330} tone="bad" label="no" />
      <Elbow x1={550} y1={150} x2={596} y2={133} midX={575} tone="ok" label="yes" />
      <Elbow x1={465} y1={204} x2={596} y2={199} midX={520} tone="bad" label="no" />
      <text className="sd-caption" x={400} y={240} textAnchor="middle">A sold or shipped pair is skipped entirely — shelving will not quietly bring it back to life.</text>
    </Svg>
  );
}

// Where a listing flag comes from and what clears it.
function ListingSync() {
  return (
    <Svg w={800} h={250} title="Store listing and sync">
      <Box x={20} y={90} w={160} title="Intelligent Inventory" sub="II — the master" tone="accent" />
      <Box x={280} y={20} w={120} h={44} title="Alias" sub="AL" tone="ok" />
      <Box x={280} y={78} w={120} h={44} title="StockX" sub="SX" />
      <Box x={280} y={136} w={120} h={44} title="Shopify" sub="SH" />
      <Box x={470} y={78} w={160} title="GOAT only" sub="Alias only" note="II / SX / SH show N/A" tone="warn" />
      <Box x={640} y={160} w={150} h={46} title="Sold / Shipped" sub="clears all four" tone="bad" />

      <Elbow x1={180} y1={105} x2={276} y2={42} midX={230} tone="muted" />
      <Arrow x1={180} y1={112} x2={276} y2={104} tone="muted" />
      <Elbow x1={180} y1={120} x2={276} y2={158} midX={230} tone="muted" />
      <Arrow x1={400} y1={104} x2={466} y2={104} tone="warn" dashed label="if flagged" />
      <Elbow x1={690} y1={160} x2={690} y2={120} midX={690} tone="bad" />

      <text className="sd-caption" x={400} y={218} textAnchor="middle">Flags are set per SIZE by PH as each listing is actually created — they describe reality, they do not cause it.</text>
      <text className="sd-caption" x={400} y={238} textAnchor="middle">A collapsed row reads a badge as "on" only when EVERY pair in the group has it. In-store buys use none of this.</text>
    </Svg>
  );
}

// What a scanned code is, and which screens want which.
function ScanRouter() {
  const rows = [
    ['VIN', 'SBM-YYMMDD-######', 'ONE physical pair — our label', 'Shelve · Rescale · Mark Sold · Mark Shipped', 'accent'],
    ['UPC', 'box barcode', 'a shoe in a size — the maker\'s code', 'Receiving · In-store buying', 'default'],
    ['SKU', 'e.g. FD8311-401', 'the shoe across every size', 'Receiving · Price Inquiry · Images', 'default'],
    ['Shelf', 'MNH-WH-A2-04', 'a place, not a thing', 'Shelve · Inventory search', 'ok'],
  ];
  return (
    <Svg w={800} h={230} title="What scans as what">
      <text className="sd-th" x={16} y={18}>CODE</text>
      <text className="sd-th" x={110} y={18}>LOOKS LIKE</text>
      <text className="sd-th" x={264} y={18}>IDENTIFIES</text>
      <text className="sd-th" x={506} y={18}>SCREENS THAT WANT IT</text>
      {rows.map(([code, looks, ident, screens, tone], i) => {
        const y = 30 + i * 46;
        return (
          <g key={code}>
            <rect className="sd-row" x={10} y={y} width={780} height={38} rx={8} />
            <rect className="sd-chip" data-tone={tone} x={16} y={y + 8} width={76} height={22} rx={11} />
            <text className="sd-chip-text" x={54} y={y + 23} textAnchor="middle">{code}</text>
            <text className="sd-mono" x={110} y={y + 23}>{looks}</text>
            <text className="sd-body" x={264} y={y + 23}>{ident}</text>
            <text className="sd-body" x={506} y={y + 23}>{screens}</text>
          </g>
        );
      })}
      <text className="sd-caption" x={400} y={224} textAnchor="middle">Inventory and Locate accept all four and work out what you meant · a shelf code returns that shelf's contents</text>
    </Svg>
  );
}

// The hard wall between normal intake and in-store buying.
function InstoreSplit() {
  return (
    <Svg w={800} h={230} title="In-store bypasses the PH team">
      <Box x={20} y={26} w={150} title="Receiving" sub="a shipment arrives" tone="accent" />
      <Box x={230} y={26} w={160} title="PH prices & lists" sub="II · AL · SX · SH" />
      <Box x={450} y={26} w={160} title="Live on the stores" tone="ok" />
      <Arrow x1={170} y1={53} x2={226} y2={53} tone="muted" />
      <Arrow x1={390} y1={53} x2={446} y2={53} tone="muted" />

      <Box x={20} y={132} w={150} title="In-store buying" sub="bought at retail" tone="accent" />
      <Box x={230} y={132} w={160} title="Listed BY HAND" sub="on the store sites" tone="warn" />
      <Box x={450} y={132} w={160} title="In-Store Listing" sub="tick AL / SX / SH" tone="ok" />
      <Arrow x1={170} y1={159} x2={226} y2={159} tone="muted" />
      <Arrow x1={390} y1={159} x2={446} y2={159} tone="muted" />

      <line className="sd-line sd-dash" data-tone="bad" x1={200} y1={96} x2={640} y2={96} />
      <text className="sd-edge" x={420} y={90} textAnchor="middle">in-store NEVER crosses this line</text>
      <text className="sd-caption" x={400} y={206} textAnchor="middle">Shelving, locating, labels, the No Box queue and sold/shipped work identically for both. Only the PH surfaces differ.</text>
    </Svg>
  );
}

// Password reset, which spans two people.
function PasswordFlow() {
  const y = 60;
  const w = 150;
  const xs = [14, 174, 334, 494, 654];
  const nodes = [
    ['Forgot password?', 'you tap it', 'default'],
    ['Neutral reply', 'always the same', 'muted'],
    ['Admin sees a badge', 'on Check Access', 'accent'],
    ['Temp password', 'shown once', 'warn'],
    ['You set your own', 'app unblocks', 'ok'],
  ];
  return (
    <Svg w={800} h={150} title="Password reset">
      {nodes.map(([t, s, tone], i) => <Box key={i} x={xs[i]} y={y} w={w} title={t} sub={s} tone={tone} />)}
      {[0, 1, 2, 3].map((i) => <Arrow key={i} x1={xs[i] + w} y1={y + BH / 2} x2={xs[i + 1] - 4} y2={y + BH / 2} tone="muted" />)}
      <text className="sd-caption" x={400} y={26} textAnchor="middle">The reply is identical whether or not the username exists — that is what stops anyone probing for valid accounts</text>
      <text className="sd-caption" x={400} y={140} textAnchor="middle">Only the hash of the temp password is stored, so a lost one is re-issued, never looked up</text>
    </Svg>
  );
}

// --- role matrix (HTML, not SVG) --------------------------------------------
// A permission grid is a table. Rendering it as SVG would cost accessibility and
// wrap badly on a phone for no gain.
const MATRIX_COLS = ['Warehouse', 'PH Team', 'Supplier', 'Admin', 'Super'];
const MATRIX_ROWS = [
  ['Receiving & batches', ['y', '-', '-', 'y', 'y']],
  ['In-store buying & listing', ['y', 'n', '-', 'y', 'y']],
  ['Shelve · Locate · Locations', ['y', '-', '-', 'y', 'y']],
  ['No Box queue', ['y', 'r', '-', 'y', 'y']],
  ['Rescale stock', ['y', '-', '-', 'y', 'y']],
  ['Rescale requests', ['audit', 'create', '-', 'y', 'y']],
  ['Inventory & labels', ['y', '-', '-', 'y', 'y']],
  ['Mark sold / shipped', ['y', '-', '-', 'y', 'y']],
  ['Listings & Sync grid', ['r*', 'y', '-', 'r', 'y']],
  ['Prices (GI / Final)', ['n', 'y', '-', 'r', 'y']],
  ['Listing images', ['shoot', 'edit', '-', 'y', 'y']],
  ['Price Inquiry', ['-', 'y', '-', 'y', 'y']],
  ['Create purchase orders', ['-', 'y', '-', 'y', 'y']],
  ['Scan out an order', ['-', 'behalf', 'y', 'y', 'y']],
  ['PO reconciliation', ['y', 'y', '-', 'y', 'y']],
  ['Accounts & settings', ['-', '-', '-', 'y', 'y']],
];
const CELL = {
  y: ['●', 'Full access', 'ok'],
  r: ['◐', 'Read-only', 'muted'],
  'r*': ['◐', 'Read-only, prices hidden', 'muted'],
  n: ['✕', 'Blocked by design', 'bad'],
  '-': ['', 'Not part of this role', 'none'],
  audit: ['audit', 'Audits requests', 'accent'],
  create: ['create', 'Creates requests', 'accent'],
  shoot: ['shoot', 'Shoots originals', 'accent'],
  edit: ['edit', 'Uploads edited', 'accent'],
  behalf: ['on behalf', 'Can fill a manifest for a supplier', 'accent'],
};
function RoleMatrix() {
  return (
    <div className="sd-matrix-wrap">
      <table className="sd-matrix">
        <thead>
          <tr><th scope="col">Feature</th>{MATRIX_COLS.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {MATRIX_ROWS.map(([label, cells]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {cells.map((c, i) => {
                const [glyph, title, tone] = CELL[c];
                return <td key={i} data-tone={tone} title={title}><span className="sd-cell">{glyph}</span></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sd-matrix-key">
        <span data-tone="ok">●</span> full · <span data-tone="muted">◐</span> read-only ·{' '}
        <span data-tone="bad">✕</span> blocked by design · blank = not part of the role.
        Admin passes every role check automatically; Super Admin additionally edits the PH grid.
      </p>
    </div>
  );
}

// --- registry ---------------------------------------------------------------
const DIAGRAMS = {
  'receiving-wizard': { title: 'The four receiving steps', render: ReceivingWizard },
  multibox: { title: 'A multi-box batch', render: MultiBox },
  'po-flow': { title: 'A purchase order, end to end', render: PoFlow },
  'po-reconcile-states': { title: 'What each purchase-order chip means', render: PoReconcileStates },
  'po-resolution': { title: 'Resolving a short order', render: PoResolution },
  'rescale-loop': { title: 'The two rescale loops', render: RescaleLoop },
  'status-machine': { title: 'Statuses and the legal moves between them', render: StatusMachine },
  'putaway-decision': { title: 'What happens when you shelve a pair', render: PutawayDecision },
  'listing-sync': { title: 'Store listing and sync', render: ListingSync },
  'scan-router': { title: 'What scans as what', render: ScanRouter },
  'instore-split': { title: 'In-store bypasses the PH team', render: InstoreSplit },
  'password-flow': { title: 'Password reset, across two people', render: PasswordFlow },
  'role-map': { title: 'Who can do what', render: RoleMatrix },
};

export const hasDiagram = (id) => Boolean(DIAGRAMS[id]);

export function SopDiagram({ id }) {
  const d = DIAGRAMS[id];
  if (!d) return null;
  const Render = d.render;
  return (
    <figure className="sd-figure">
      <figcaption className="sd-figcap"><span className="sd-figkicker">Schematic</span>{d.title}</figcaption>
      <div className="sd-canvas"><Render /></div>
    </figure>
  );
}
