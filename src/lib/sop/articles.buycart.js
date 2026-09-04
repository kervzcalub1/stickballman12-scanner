// The gift-card buying process — request → approval → cards → receipt → audit →
// expected inventory → shipment → receiving → reconciled.
//
// Its own file for the same reason articles.payout.js is: it belongs to no single desk.
// Four people touch every transaction and each of them needs a different procedure, so
// the articles below are written one per JOB rather than one per screen. That is also
// the point of the process itself — the jobs are separate on purpose, and a document
// that merged them would be teaching the opposite of what the system enforces.
//
// A naming trap worth repeating here because staff will read these: the person who goes
// to the shop is the BUYER (a `supplier` account, because they also ship us the boxes).
// The people who release the cards are the GIFT CARD DESK (`gc_issuer`). The written
// process calls those people "gift card suppliers", which is a different thing entirely.
// Nothing in this copy says "supplier" for either.
const STAFF = ['warehouse', 'ph_team', 'admin', 'superadmin'];
const EVERYONE = ['warehouse', 'ph_team', 'supplier', 'gc_issuer', 'auditor', 'admin', 'superadmin'];

export const BUYCART_ARTICLES = [
  {
    id: 'buycart-overview',
    title: 'How company money buys shoes, end to end',
    area: 'buying',
    roles: EVERYONE,
    summary: 'Ten steps from "can I have gift cards" to CLOSED / RECONCILED, and who owns each one. Nothing closes until approved money out matches verified inventory in.',
    when: 'Read this once before you touch any part of the gift-card process.',
    steps: [
      { do: 'A BUYER opens a request and lists what they want to buy — SKU, size, quantity and the shelf price. The app prices each pair and says Buy, Watch or Pass.' },
      { do: 'They send it for approval. The request will not send without saying what is being bought and which store.' },
      { do: 'WAREHOUSE, PH or ADMIN approves line by line, or all at once. Turning a line down takes a reason.' },
      { do: 'The GIFT CARD DESK records the cards issued and releases them. The cards must cover the approved total first.' },
      { do: 'The buyer goes shopping, and uploads the receipt. Every time — the receipt is not optional.' },
      { do: 'The receipt is read into lines (paste, PDF or a photo), checked in an editable table, and saved.' },
      { do: 'Those lines raise a PURCHASE ORDER. That is the "expected inventory" — stock the company has paid for and has not yet got.' },
      { do: 'An AUDITOR records what each card was actually spent and what is left on it.' },
      { do: 'The buyer packs, asks for labels and ships. The warehouse receives against the order exactly as it does any other shipment.' },
      { do: 'When all ten closing conditions are true, the auditor marks it CLOSED / RECONCILED.' },
    ],
    rules: [
      'No known purchase and no approval = no gift cards. The app refuses to record a card against a request that has not been approved.',
      'You cannot approve your own request. A buyer has no approve button and the server refuses the call.',
      'You cannot audit a request you approved. The app refuses, by account, even for an admin.',
      'A transaction is NOT complete because the cards were spent. It is complete when every one of the ten closing conditions is true in the data.',
      'There is no override on the close. If something is genuinely stuck — a receipt that no longer exists — that is a conversation, not a button.',
    ],
    related: ['buycart-buyer', 'buycart-approve', 'buycart-issue', 'buycart-audit'],
    keywords: ['gift card', 'buying', 'request', 'approval', 'reconcile', 'audit', 'money', 'process', 'GC'],
  },

  {
    id: 'buycart-buyer',
    title: 'Asking for gift cards, and sending the receipt back (buyer)',
    area: 'buying',
    roles: ['supplier'],
    summary: 'Open a request, scan or type each pair you want, read the buy call, send it for approval — then spend the cards and send the receipt.',
    when: 'Before a store trip, and again the moment you have paid.',
    steps: [
      { do: 'Home → Buying Requests → New request. Say what you are buying and which store.', note: 'Be specific. "Restocking Panda Dunks for GOAT" gets approved; "just buying stuff" does not, and the app will not send it either.' },
      { do: 'Type a SKU and press Look up, or press Scan and point the camera at the barcode on the box.', note: 'A barcode is a UPC — it names one size, so the app prices that size straight away without you tapping one.' },
      { do: 'Tap the size you are holding. Alias and StockX prices load.' },
      { do: 'Type the price on the shelf and how many pairs.', warn: 'The shelf price is what the gift cards get sized against. Type the sticker, not what you think it will ring up at.' },
      { do: 'Read the call, then Add to request. Repeat for every pair.' },
      { do: 'Send for approval. You can pull it back while nobody has decided on it yet.' },
      { do: 'When the cards are released, open the request and press Show code on each card as you need it.', note: 'The code goes into the till. Tap it to copy rather than retyping sixteen digits.' },
      { do: 'After paying: open the request, Upload receipt, then paste the receipt text or let the photo be read.' },
      { do: 'Check every row in the table — fix anything misread, delete anything that is not a shoe — then Save these lines.', warn: 'This is what the money gets reconciled against. A wrong number here is a wrong number in the accounts.' },
      { do: 'Enter the receipt total as the till charged it — including tax. It is usually more than the rows add up to.' },
    ],
    rules: [
      'Ask for a receipt EVERY time. Without it the transaction can never be closed, and it will sit against your name.',
      'You can add a pair the app calls a Pass. Say why in the history — the person approving will see the red chip and want a reason.',
      'A request is locked once you send it. Pull it back if you need to change it, which only works before anyone has decided.',
      'Reading a card code is recorded against your name, with the time. That is normal — it is how the company can account for the money.',
      'The cards are sized on the sticker price, so the till may ask for a little more once tax is added. If a card comes up short, say so in the history rather than paying the difference yourself.',
    ],
    related: ['buycart-overview', 'supplier-scanout', 'payout-calculator'],
    keywords: ['buyer', 'request', 'gift card', 'receipt', 'shopping', 'store', 'scan', 'shelf price'],
  },

  {
    id: 'buycart-approve',
    title: 'Approving a buying request',
    area: 'buying',
    roles: STAFF,
    summary: 'Read what the buyer wants, check the call on each line, approve or turn down — line by line or in bulk. What you approve is what gets funded.',
    when: 'A request shows in the "To approve" queue, or on the Home attention strip.',
    steps: [
      { do: 'Home → Gift Card Buying, or tap the "Buy requests" card on the attention strip.' },
      { do: 'Open the request and read what they said they are buying. If it does not tell you what the money is for, ask in the history rather than approving it.' },
      { do: 'Go down the lines. Each carries the call as the buyer saw it, with the profit, the ROI and which platform it came from.', note: 'That call is a SNAPSHOT from when the pair was added. The market may have moved since; it is deliberately not re-computed, so you see what they saw.' },
      { do: 'Tick the lines you want and press Approve selected, or Approve all to take the lot.' },
      { do: 'Turn down what you do not want, with a reason. The reason shows on the buyer’s screen.' },
      { do: 'Once nothing is pending, the request moves to the gift card desk on its own.' },
    ],
    rules: [
      'The approved total is the SHELF price of every approved pair — no discounts assumed. That is what the cards get sized against.',
      'Approving is not funding. Somebody at the gift card desk still has to record the cards.',
      'Once cards have been issued the approvals FREEZE. You cannot un-approve a line the money has already gone out against.',
      'If you approve a request you must not be the one who audits it later. The app will refuse you.',
      'A Pass is not automatically a no. The buyer is standing in the shop and may know something the market data does not — ask, then decide.',
    ],
    related: ['buycart-overview', 'buycart-issue', 'payout-calculator'],
    keywords: ['approve', 'reject', 'buy request', 'bulk approve', 'queue', 'decision'],
  },

  {
    id: 'buycart-issue',
    title: 'Releasing gift cards against an approved request',
    area: 'buying',
    roles: ['gc_issuer', 'ph_team', 'admin', 'superadmin'],
    summary: 'Record each card and its balance, check the total covers what was approved, then release it to the buyer.',
    when: 'A request shows in the "Needs gift cards" queue.',
    steps: [
      { do: 'Open the request and read the approval: who approved it, and for how much.' },
      { do: 'For each card, type the number, the PIN if there is one, and what is on it. Press Record card.', note: 'The number is encrypted the moment it is saved. Afterwards only the last four show, and reading the full code is a separate, recorded action.' },
      { do: 'If the cards came as photos or a PDF, use Add image / PDF instead — those count too, and page through them with the arrows in the viewer.' },
      { do: 'Watch the funding line. It says what the cards total against what was approved, and how much is still short.' },
      { do: 'Press Release to the buyer once it reads "covered".' },
    ],
    rules: [
      'A card can only go against an APPROVED request. That is the process’s first rule, and the app enforces it.',
      'The cards must cover the approved total before anything is released. The button stays disabled and names the shortfall.',
      'Watch the amber note. When the buyer’s discount is small and the sales tax is not, the till can ask for MORE than the sticker — the note says how much, and it is worth funding to that.',
      'Never delete a card that was issued — Withdraw it, with a reason. A card that went out and came back is a thing that happened to company money.',
      'If the app says gift card codes cannot be stored securely, do not paste one anywhere else. Upload a photo instead and tell an admin the key is not set.',
    ],
    related: ['buycart-overview', 'buycart-approve', 'buycart-audit'],
    keywords: ['gift card', 'issue', 'release', 'fund', 'balance', 'GC', 'card number', 'PIN'],
  },

  {
    id: 'buycart-audit',
    title: 'Auditing the spend and closing a transaction',
    area: 'buying',
    roles: ['auditor', 'admin', 'superadmin'],
    summary: 'Account for every card: what it was spent, what is left. Then check the ten closing conditions and mark it reconciled.',
    when: 'A request shows in the "To audit" queue, and again when its shipment has been received.',
    steps: [
      { do: 'Open the request. Read the receipt lines against what was approved — the app flags anything bought that nobody approved, or approved and never bought.' },
      { do: 'In Financial audit, enter what each card was actually spent and what is left sitting on it.' },
      { do: 'Check the line under it: the cards must account for the receipt total. A gap is a finding — chase it before you record anything.' },
      { do: 'Press Record the audit.' },
      { do: 'Read the closing conditions. Anything not ticked says what is missing.' },
      { do: 'When all ten are green — usually once the shipment has physically arrived and reconciled — press Close / reconciled.' },
    ],
    rules: [
      'You cannot audit a request you approved. The app refuses by account, admin included. Somebody else has to do it.',
      'Both numbers per card, or neither means anything. "Spent $180" with no remaining balance leaves the last condition unanswerable.',
      'Do not force the arithmetic to balance. An unexplained gap between cards issued, receipt and remaining balance is exactly what this step exists to surface.',
      'Six of the ten conditions are answered by the purchase order, not by you — shipped, received, and expected-matches-received come straight off the shipment.',
      'There is no override. If a condition genuinely cannot be met, raise it — do not look for a way around the gate.',
    ],
    related: ['buycart-overview', 'buycart-issue', 'reconcile-warehouse'],
    keywords: ['audit', 'reconcile', 'close', 'balance', 'remaining', 'spend', 'closing conditions', 'ten checks'],
  },
];
