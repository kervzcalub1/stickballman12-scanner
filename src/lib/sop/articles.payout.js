// The Payout Calculator — the "should we buy this pair?" desk.
//
// It belongs to no single role, which is why it has its own file rather than living
// under warehouse or PH: the person standing in a shop with a pair in their hand is
// as often a buyer as a lister, and admin supervises both. Suppliers get the same
// screen on their portal but a narrower version of it (their own cost stack, read
// only) — their procedure is in articles.supplier.js, not here.
const STAFF = ['warehouse', 'ph_team', 'admin', 'superadmin'];

export const PAYOUT_ARTICLES = [
  {
    id: 'payout-calculator',
    title: 'Should we buy this pair? (Payout Calculator)',
    area: 'listing',
    roles: STAFF,
    summary: 'Look up a shoe, tap the size in your hand, fill the cost stack, and read the Buy / Watch / Pass. Nothing is saved — it never touches inventory.',
    when: 'Standing in a store, or reading an offer, and deciding whether the pair is worth taking.',
    steps: [
      { do: 'Open it: Home → In-Store Mode → Payout Calculator (warehouse/admin), or PH home → Pricing & Listing → Payout Calculator.' },
      { do: 'Type the SKU and press Look up.', note: 'Optional. If you already know the sale price you can type it straight into a platform box and skip the shoe entirely.' },
      { do: 'Tap the size you are holding. Both markets load — Alias on the basis chosen above the sizes, and StockX.' },
      { do: 'Read the call. There is already one: each platform fills its own sale price from its OWN lowest ask, so you do not have to tap a price to get an answer.', note: 'The highlighted cell is the number being used. Tap Highest offer, Last sold or Global indicator to use that instead, or type your own — then no cell is highlighted, because you are not using any of them.' },
      { do: 'Tap the supplier who is buying it. That fills the whole Store cost stack in one go — tip, shipping, sales tax, gift card and the rest.', note: 'Every field stays editable afterwards. The moment one diverges, the chip stops claiming the supplier and says so.' },
      { do: 'Type the shelf price. Final cost is what the pair actually costs us, landed.' },
      { do: 'Read the verdict: Buy, Watch or Pass, with the profit per pair, the ROI and the risk band.' },
    ],
    rules: [
      'A Buy needs BOTH: at least $15 profit a pair AND at least 15% ROI. One of the two is a Watch; neither is a Pass.',
      'Alias is quoted "With You" by default — you hold the pair and ship it when it sells. Consigned is a different, usually higher number, and switching re-prices the size rather than relabelling a stale one.',
      'StockX has no last-sale figure. There is no such field in their API, whatever stockx.com shows you — never quote one.',
      'Nothing on this screen is saved. It writes no item, no batch, and no price. Close it and it is gone.',
      'A blank Fee box means the platform default (Alias 9.9%, StockX 10%), never 0%.',
    ],
    related: ['payout-markup', 'payout-batch', 'ph-price-inquiry'],
    keywords: ['payout', 'buy call', 'ROI', 'profit', 'lowest ask', 'fees', 'verdict', 'watch', 'pass', 'cost stack', 'supplier preset'],
  },
  {
    id: 'payout-markup',
    title: 'Markup — pricing above the ask',
    area: 'listing',
    roles: STAFF,
    summary: 'Work out what a pair pays if you list above the market — and see plainly when the markup, not the market, is what made it look like a buy.',
    when: 'You intend to list higher than the current lowest ask and want to know whether that changes the answer.',
    steps: [
      { do: 'In Expected payouts, switch Markup from Off to On.', note: 'It is off by default, and while it is off the box is not rendered at all — a markup box holding a number that is not being applied reads as though it counts.' },
      { do: 'Type the percentage into the platform you are marking up. It is per platform: 10% over Alias and nothing over StockX is normal.' },
      { do: 'Read the breakdown: sale, plus markup, listed at, minus fees, payout.' },
      { do: 'Check the call. With markup on, the verdict is made on the marked-up prices — that is the point of turning it on.' },
      { do: 'If an amber "Markup changed this call" panel appears, read it. It names both answers: what the pair is at the market price, and what it is at yours.' },
    ],
    rules: [
      'The fee is a cut of the LISTED price, not the ask you started from. A platform takes its percentage of the real sale.',
      'A markup is a price you HOPE to get. Nobody has offered it. Treat an amber Buy as "worth watching at that price", not as a decision already made.',
      'The amber panel only appears when the markup actually CHANGED the call. A markup that leaves the call alone gets one quiet grey line — so when you do see amber, it means something.',
      'Switch Markup back Off and the numbers return to the market’s answer. The percentage you typed is remembered but not applied.',
    ],
    related: ['payout-calculator', 'payout-batch'],
    keywords: ['markup', 'list above the ask', 'listed at', 'ROI', 'buy call', 'amber warning'],
  },
  {
    id: 'payout-batch',
    title: 'Price a whole list at once',
    area: 'listing',
    roles: STAFF,
    summary: 'A supplier sends forty pairs — paste the message, check what it read, and get a call on every line plus the deal as one number.',
    when: 'Someone offers you a list rather than a single pair.',
    steps: [
      { do: 'Scroll to the bottom of the Payout Calculator: "Or price a whole list".' },
      { do: 'Fill the Store cost stack above it FIRST — or tap the supplier preset. Every pasted price runs through it.' },
      { do: 'Paste the message into the box and press Read the list.', note: 'Two shapes work: a style code with its sizes underneath ("IB8857 141" then "10 x 5"), or everything on one line per size. A space instead of a dash in the style code is fine.' },
      { do: 'CHECK WHAT IT READ. Fix any size, quantity or price it got wrong, drop the lines that were not shoes, and add anything it missed.', warn: 'Do not skip this. It is a guess off a chat message, and a misread size prices a different shoe.' },
      { do: 'Choose what the price column means: "Shelf prices" runs each one through the cost stack above; "Already my cost" takes it as the landed cost per pair, exactly as typed.' },
      { do: 'Press Analyse. Every row gets a call, and the deal totals sit above them: pairs, total cost, total payout, total profit and blended ROI.' },
      { do: 'Filter to Buy to see what is worth taking, or to Gaps to see what could not be answered.' },
    ],
    rules: [
      'Your coupon is never applied to a list. It is one amount off one transaction — spreading it across forty pairs would quietly knock the whole batch down.',
      'Rows we could not price, and rows with no cost, are counted separately and kept OUT of the totals. A blank averaged into a blended ROI makes a bad batch look acceptable.',
      'Results sort by what the LINE is worth, not the pair: $6 a pair over forty pairs outranks $40 over one.',
      'A line with no style code is skipped rather than guessed at. If a whole paste comes back "Nothing recognisable", every line was missing one.',
      'Up to 40 styles are priced per run. Anything past that is reported, not silently dropped — run the rest as a second batch.',
    ],
    related: ['payout-calculator', 'payout-markup'],
    keywords: ['batch', 'bulk', 'paste', 'whole list', 'offer sheet', 'blended ROI', 'gaps'],
  },
];
