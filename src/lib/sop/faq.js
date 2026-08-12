// FAQ — the questions people actually ask, answered in one paragraph each.
//
// The bar for an entry: it is a real misunderstanding, and the answer is short.
// Anything that needs steps belongs in an article (link to it with `see`).
const ALL = ['warehouse', 'ph_team', 'supplier', 'admin', 'superadmin'];
const STAFF = ['warehouse', 'ph_team', 'admin', 'superadmin'];
const WH = ['warehouse', 'admin', 'superadmin'];
const PH = ['ph_team', 'admin', 'superadmin'];
const SUP = ['supplier', 'admin', 'superadmin'];

export const FAQ = [
  // ------------------------------------------------------------ scanning ----
  {
    id: 'faq-vin-gap',
    q: 'The VIN numbers skipped a few. Did we lose stock?',
    a: 'No. VINs come from a counter that only ever goes up, and a number is burned whenever one is reserved — including on an intake that was abandoned. Gaps are expected and harmless. What matters is that a number is never re-used, so a VIN always points at exactly one pair, forever.',
    area: 'reference', roles: STAFF, see: 'scan-guide',
    keywords: ['vin', 'sequence', 'missing numbers', 'gap', 'skipped'],
  },
  {
    id: 'faq-two-same-pairs',
    q: 'Two identical pairs in the same size — do they share a VIN?',
    a: 'No. A VIN is per physical pair, not per shoe or per size. Two identical size-10s get two VINs and two labels, which is what lets you sell one and still know exactly where the other is.',
    area: 'reference', roles: STAFF, see: 'scan-guide',
    keywords: ['vin', 'duplicate', 'per pair', 'identical', 'same size'],
  },
  {
    id: 'faq-scan-nothing',
    q: 'I scanned the box and nothing happened.',
    a: 'Check what you scanned against what the screen wants. Receiving and in-store want the box UPC or the SKU. Rescale, Mark Sold, Mark Shipped and Shelve want the VIN off our own label. Scanning a UPC into a VIN screen does nothing useful. If the camera preview itself is frozen, close and reopen the scanner.',
    area: 'reference', roles: STAFF, see: 'scan-guide',
    keywords: ['scan', 'nothing', 'not working', 'wrong code', 'camera'],
  },
  {
    id: 'faq-camera-black',
    q: 'The camera preview is black.',
    a: 'Close the scanner and reopen it, and make sure no other app is holding the camera. There is a Retry button on the loading overlay. The scanner releases the camera properly when you close it, so reopening is a genuine reset rather than a superstition.',
    area: 'reference', roles: ALL, see: 'troubleshooting',
    keywords: ['camera', 'black', 'preview', 'frozen', 'stalled', 'retry'],
  },
  {
    id: 'faq-keyboard',
    q: 'The keyboard will not open on my iPhone.',
    a: 'Tap directly into the field. The app deliberately does not auto-focus inputs on mobile — on iOS Safari a programmatic focus sets the cursor but suppresses the keyboard, which reads as the keyboard being broken. One deliberate tap always works.',
    area: 'reference', roles: ALL, see: 'troubleshooting',
    keywords: ['keyboard', 'iphone', 'ios', 'focus', 'safari', 'mobile'],
  },

  // ------------------------------------------------------------- statuses ---
  {
    id: 'faq-cant-set-instock',
    q: 'Why can I not just set a pair to "In Stock"?',
    a: 'Because In Stock means "on a shelf, and we know which one". Setting it by hand would create pairs that are in stock nowhere, which nobody can pick. Picking In Stock opens the Move-to-shelf scanner instead — scan the shelf and the status follows automatically.',
    area: 'reference', roles: STAFF, see: 'statuses-explained',
    keywords: ['in stock', 'status', 'blocked', 'shelf', 'move to shelf', '409'],
  },
  {
    id: 'faq-unsell',
    q: 'I marked the wrong pair sold. Can I undo it?',
    a: 'Not back into an active status — sold and shipped are terminal, which is what stops a pair being accidentally re-listed and double-sold. You can move it between sold and shipped. If a pair genuinely came back, receive it as a rescale with the reason "Returned"; that is the intended route and it leaves an honest trail.',
    area: 'reference', roles: WH, see: 'statuses-explained',
    keywords: ['undo', 'sold', 'mistake', 'terminal', 'reverse', 'returned', 'double sell'],
  },
  {
    id: 'faq-listing-disappeared',
    q: 'A pair sold and its store flags all cleared themselves.',
    a: 'That is intended. Marking a pair sold or shipped delists it from Intelligent Inventory, Alias, StockX and Shopify in the same action, so nobody has to remember to. The history records it as system-generated.',
    area: 'reference', roles: STAFF, see: 'sync-flags',
    keywords: ['flags cleared', 'delist', 'sold', 'cascade', 'sync', 'system generated'],
  },
  {
    id: 'faq-shelve-nobox',
    q: 'It will not let me shelve a pair.',
    a: 'Almost always because it has no box. A boxless pair cannot go on a shelf as sellable stock. If you are holding the box, tick "box found now?" and it goes on as a with-box pair. If you are not, resolve it in the No Box queue. Sold and shipped pairs are also skipped rather than being brought back to life.',
    area: 'putaway', roles: WH, see: 'shelve-putaway',
    keywords: ['shelve', 'refused', 'no box', 'rejected', 'box found', 'blocked'],
  },
  {
    id: 'faq-renamed-shelf-labels-dead',
    q: 'I renamed an area and now none of its shelf tags scan.',
    a: 'That is expected, and the app told you so before you saved. The site and the area are part of the shelf barcode itself (MNH-WH-A2-04), so renaming either one re-issues the code on every shelf underneath. The shoes never moved and nothing is lost — the tags on the rack are just the old codes now. Reprint them from the print dialog that opens on save, or tick the level on the Locations page and use "Print labels".',
    area: 'putaway', roles: WH, see: 'locations-edit-delete',
    keywords: ['rename', 'area', 'site', 'labels', 'not scanning', 'dead tag', 'reprint', 'barcode changed'],
  },
  {
    id: 'faq-cannot-delete-location',
    q: 'It will not let me delete this bay / area / site.',
    a: 'Pairs are still shelved somewhere underneath it. The refusal is all-or-nothing on purpose — it does not quietly delete the empty shelves and keep the occupied ones, because a half-deleted rack is worse than none. Move that stock to another shelf first, then delete. Sold and shipped pairs never block it. If the rack is simply out of use rather than gone, deactivate it instead and keep the history.',
    area: 'putaway', roles: WH, see: 'locations-edit-delete',
    keywords: ['delete', 'blocked', 'refused', 'still shelved', 'live stock', 'deactivate', 'remove'],
  },
  {
    id: 'faq-delete-or-deactivate',
    q: 'Should I delete a shelf or deactivate it?',
    a: 'Deactivate by default. It hides the shelf from put-away and keeps every record of what sat there, so it can come back. Delete only when the shelf should never have existed or the rack is physically gone — it is permanent, and its barcode stops resolving for good. Deleting a folder (a bay, row, area or site) deletes every shelf under it, not just the folder.',
    area: 'putaway', roles: WH, see: 'locations-edit-delete',
    keywords: ['delete', 'deactivate', 'retire', 'inactive', 'permanent', 'difference'],
  },

  // ---------------------------------------------------------------- no box --
  {
    id: 'faq-nobox-missing-grid',
    q: 'Stock I received is missing from the listing grid.',
    a: 'Check the No Box queue. Pairs received without a box are not postable and are deliberately hidden from PH\'s New Inventory until the box turns up. In-store buys are also absent from that grid by design — they are listed by hand on the In-Store Listing page.',
    area: 'listing', roles: STAFF, see: 'ph-nobox-view',
    keywords: ['missing', 'not showing', 'grid', 'no box', 'hidden', 'in-store'],
  },
  {
    id: 'faq-label-preview-gone',
    q: 'Printing labels used to show me the labels first. Where did that go?',
    a: 'It was removed on purpose — it was a preview of a preview. Print now opens one small dialog: pick your label stock, tap Print. On a phone that hands the PDF straight to the share sheet, where you tap Print to send it to your label printer; on a computer it goes to the print dialog itself. The PDF is what actually prints, so that is the only preview worth reading, and you still see it in the share sheet or the PDF viewer before anything comes out. Nothing about the labels themselves changed.',
    area: 'putaway', roles: WH, see: 'print-labels',
    keywords: ['preview', 'print', 'label sheet', 'extra step', 'share', 'gone', 'changed'],
  },
  {
    id: 'faq-box-label-blank',
    q: 'A box label printed with no barcode.',
    a: 'That pair has no UPC on its record — usually an older item scanned by SKU only, and a UPC cannot be worked backwards from a SKU because it differs per size. You should have been asked for one before it printed: read the UPC off the tongue label inside the shoe and type it in, and it is saved to the pair for next time. A label only comes out text-only if that prompt was skipped with "No UPC found".',
    area: 'putaway', roles: WH, see: 'box-labels',
    keywords: ['box label', 'no barcode', 'upc missing', 'blank', 'text only', 'legacy', 'tongue label'],
  },
  {
    id: 'faq-box-label-not-found',
    q: 'Box Labels says "No product found" for a shoe I know we have.',
    a: 'Scan its VIN sticker instead of the UPC. The page checks our own stock first and then an outside catalogue, and the catalogue has never heard of old stock, in-store buys, or anything typed in by hand. If the pair is in our system the VIN always finds it. If it has no VIN yet, type the SKU instead of scanning the UPC.',
    area: 'putaway', roles: WH, see: 'box-labels',
    keywords: ['no product found', 'not found', 'box labels', 'upc', 'catalogue', 'old stock'],
  },
  {
    id: 'faq-box-label-give-vin',
    q: 'Should I use "Give it a VIN + print both"?',
    a: 'Only if the pair genuinely is not in the system yet. If the page lists matching pairs under "already in inventory", one of them is the shoe in your hand — tap "Use this VIN" instead. Creating a second VIN for a pair we already hold counts the same shoe twice and it will read as stock we do not have.',
    area: 'putaway', roles: WH, see: 'box-labels',
    keywords: ['give it a vin', 'duplicate', 'double count', 'box labels', 'new vin'],
  },

  // ------------------------------------------------------------ scan-out ----
  {
    id: 'faq-scanout-not-saved',
    q: 'I scanned 60 pairs out and none of them are marked shipped.',
    a: 'Scanning builds a list; nothing is written until you tap "Save → Shipped" and confirm. That is deliberate — it is what makes a mis-scan harmless. If you left the page without submitting, the list is gone and the pairs are untouched. Scan them again and submit this time.',
    area: 'fulfil', roles: WH, see: 'mark-shipped',
    keywords: ['not saved', 'scan out', 'shipped', 'lost', 'submit', 'confirm'],
  },
  {
    id: 'faq-scanout-two-buzzes',
    q: 'What do the two low buzzes mean?',
    a: 'That scan did not go on the list. The banner names the reason and it is also written to the "failed scans" panel, which keeps every failure for the whole session instead of being wiped by the next scan. Usual causes: you scanned the product UPC instead of the VIN, the pair is already shipped, or you scanned the same box twice. One short high blip is the good sound.',
    area: 'fulfil', roles: WH, see: 'mark-shipped',
    keywords: ['buzz', 'beep', 'sound', 'error', 'failed scan', 'red', 'noise'],
  },
  {
    id: 'faq-scanout-remaining',
    q: 'What is the "Remaining" number counting?',
    a: 'Pairs marked Sold that have not been shipped yet — the backlog still waiting to go out. It drops as you scan, before you submit, so it shows what will be left when you finish this trolley. Mark Sold has no equivalent, because there is no queue of pairs waiting to be sold.',
    area: 'fulfil', roles: WH, see: 'mark-shipped',
    keywords: ['remaining', 'counter', 'backlog', 'awaiting shipment', 'sold'],
  },
  {
    id: 'faq-scanout-double-scan',
    q: 'I scanned the same box twice and got nothing the second time.',
    a: 'Within about a second, a repeat of the same barcode is treated as the scanner gun double-triggering and is ignored on purpose — otherwise every gun bounce would fill the error list. Scan it again a moment later and you will get a proper duplicate warning. Either way it is only ever counted once.',
    area: 'fulfil', roles: WH, see: 'mark-shipped',
    keywords: ['double scan', 'duplicate', 'twice', 'ignored', 'cooldown', 'gun'],
  },

  // -------------------------------------------------------------- receiving --
  {
    id: 'faq-continue-batch',
    q: 'How do I continue a batch? I open it and the boxes just say "pending".',
    a: 'Tap "Add items" on the row of the box you are holding. "Pending" means that box is recorded but nothing has been scanned into it yet, and that button drops you into the receiving wizard aimed at that exact box — its number and tracking number come with it, so everything you scan lands in it. Use "+ Add box" only for a box that is not listed at all (a late arrival, or one nobody recorded); it creates the NEXT box number, so using it to continue a pending box leaves you with an empty box beside the one you meant to fill. Received boxes have no button — they are closed.',
    area: 'intake', roles: WH, see: 'batches-manage',
    keywords: ['continue', 'resume', 'pending', 'batch', 'add items', 'add box', 'stuck', 'no way to'],
  },
  {
    id: 'faq-tracking-required',
    q: 'Why will it not let me commit without a tracking number?',
    a: 'A receiving batch has to be traceable back to the shipment it came from — that link is what makes a discrepancy investigable weeks later. Supplier and tracking are both required and the server enforces it. If the shipment genuinely arrived without a tracking number — hand-delivered, local pickup, a supplier who never sent one — tick "No tracking number" under the field: it commits, and the batch records that there was none, which is different from a blank field. Rescale and in-store batches are exempt, since there is no shipment.',
    area: 'intake', roles: WH, see: 'receive-single',
    keywords: ['tracking', 'required', 'supplier', 'commit', 'blocked', '400', 'no tracking number', 'hand delivered', 'pickup'],
  },
  {
    id: 'faq-duplicate-tracking',
    q: 'It says this tracking number has been used before.',
    a: 'It is a warning, not a block. Commit anyway if it is genuinely a re-send or a re-used label, and the batch is tagged as a duplicate so it can be picked apart later. If it is not, you may be about to scan the same box in twice.',
    area: 'intake', roles: WH, see: 'receive-single',
    keywords: ['duplicate', 'tracking', 'warning', 'already used', 'resend'],
  },
  {
    id: 'faq-box-already-submitted',
    q: '"This box has already been submitted."',
    a: 'Two people committed the same box at nearly the same moment and you were second. The first commit won and the items are in. This is the app preventing a double-count — check the batch page before scanning it again.',
    area: 'intake', roles: WH, see: 'receive-multibox',
    keywords: ['already submitted', 'conflict', '409', 'double', 'multi-box', 'concurrent'],
  },
  {
    id: 'faq-box-zero-items',
    q: 'A box on the batch page shows a red 0.',
    a: 'Its tracking number was recorded but no items were ever scanned into it. Either it has not been done yet, or it arrived empty. Empty box slots are kept on purpose rather than hidden — a box that vanished from the page would be a box nobody chases.',
    area: 'intake', roles: WH, see: 'batches-manage',
    keywords: ['zero items', 'red 0', 'empty box', 'batch page', 'missing items'],
  },
  {
    id: 'faq-forgot-photos',
    q: 'I forgot to shoot listing photos at intake.',
    a: 'Not a problem to redo at intake — photos are per SKU, so they can be added the next time that SKU comes through, and PH can source or upload images themselves from Find Image Listings. Photos never block a commit.',
    area: 'intake', roles: WH, see: 'listing-photos-intake',
    keywords: ['photos', 'forgot', 'missing', 'per sku', 'later'],
  },

  // -------------------------------------------------------------- in-store ---
  {
    id: 'faq-instore-not-in-ph',
    q: 'Why do in-store buys never reach the PH team?',
    a: 'Because they are listed to the stores by hand, deliberately. In-store is a fast-moving buying flow and routing it through pricing and sync would slow it to a crawl. The exclusion is enforced everywhere — the listing grid, the rescale worklist, the pending badges — not just on one screen.',
    area: 'instore', roles: STAFF, see: 'instore-buying',
    keywords: ['in-store', 'ph team', 'excluded', 'bypass', 'manual', 'why'],
  },
  {
    id: 'faq-instore-rescale',
    q: 'It refuses to rescale an in-store pair.',
    a: 'Correct. Rescaling marks a pair for restock, which is what puts it on PH\'s worklist — and in-store stock must never land there. If an in-store pair needs re-listing, do it by hand and tick it off on the In-Store Listing page.',
    area: 'instore', roles: WH, see: 'instore-buying',
    keywords: ['rescale', 'instore', 'refused', '409', 'restock', 'blocked'],
  },

  // --------------------------------------------------------------- listing --
  {
    id: 'faq-wy-chip',
    q: 'What is the chip beside a price — WY, LOW, LAST, HIGH?',
    a: 'It says which Alias number priced that size. The app takes the first one that exists, in this order: Global Indicator, then Lowest, then Last Sold, then Highest — consigned before "With You" at each step. No chip means the normal consigned Global Indicator. WY = With You. LOW = Lowest ask, LAST = Last sold, HIGH = Highest offer, each with ·WY when it came off the With You basis. Amber chips are still a live asking price; rose ones (LAST, HIGH) are a past sale or somebody\'s bid, so check them against cost before listing. Typing a price by hand clears the chip.',
    area: 'listing', roles: PH, see: 'ph-pricing-hierarchy',
    keywords: ['WY', 'with you', 'consigned', 'GI', 'basis', 'chip', 'amber', 'rose', 'LOW', 'LAST', 'HIGH', 'hierarchy', 'lowest', 'last sold', 'highest'],
  },
  {
    id: 'faq-price-below-cost',
    q: 'A size came back priced way below what we paid for it.',
    a: 'Look at the chip. If it is rose (LAST or HIGH) Alias had no Global Indicator and no live ask for that size, so the price came off a past sale or somebody\'s offer — on odd sizes that can be a fraction of cost. The app does not floor it at cost; it marks up whatever it found. Type the price you actually want and the chip clears.',
    area: 'listing', roles: PH, see: 'ph-pricing-hierarchy',
    keywords: ['below cost', 'too cheap', 'wrong price', 'highest offer', 'bid', 'last sold', 'loss', 'odd size'],
  },
  {
    id: 'faq-goat-only',
    q: 'StockX and Shopify show N/A and will not let me tick them.',
    a: 'The shoe is flagged GOAT only — a warehouse decision made at intake, shown as a purple chip. It lists to Alias and Intelligent Inventory only, and StockX and Shopify are excluded from its completion and from the backlog counts. If the flag is wrong, it can be toggled on the grid.',
    area: 'listing', roles: PH, see: 'sync-flags',
    keywords: ['goat only', 'N/A', 'stockx', 'shopify', 'purple chip', 'disabled'],
  },
  {
    id: 'faq-price-reverted',
    q: 'I set a price and a refresh changed it back.',
    a: 'Manual overrides are kept only for pairs that are already listed — on Intelligent Inventory or any store. Unlisted pairs always take the fresh calculation, so that a margin change actually reaches them. Tick the pair onto II or a store first if you want your number to stick.',
    area: 'listing', roles: PH, see: 'ph-refresh-prices',
    keywords: ['price', 'reverted', 'overwritten', 'override', 'refresh', 'margin', 'unlisted'],
  },
  {
    id: 'faq-margin-change',
    q: 'We changed the margin. Did every price update?',
    a: 'Only unlisted stock was re-priced immediately, and only where the price was still the old automatic calculation — manual overrides and live listings were left alone on purpose. To move listed stock onto the new margin, PH runs Refresh prices over it.',
    area: 'admin', roles: ['admin', 'superadmin', 'ph_team'], see: 'admin-settings',
    keywords: ['margin', 'markup', 'settings', 'reprice', 'listed', 'unlisted'],
  },
  {
    id: 'faq-edit-locked',
    q: 'Someone else is editing the row I need.',
    a: 'Work on another row. The badge shows who has it, and it releases when they submit or cancel, after 30 seconds of a dropped connection, or after an hour idle. The badge is advisory; the real protection is the conflict check when saving, which is why you can still occasionally get a conflict on a row nobody appeared to hold.',
    area: 'listing', roles: PH, see: 'ph-grid-editing',
    keywords: ['lock', 'editing', 'presence', 'stuck', 'release', 'conflict', 'someone else'],
  },
  {
    id: 'faq-conflict',
    q: '"Someone else changed this" when I hit Submit.',
    a: 'Somebody saved that row while you had it open. The grid reloads the fresh values — redo your change on top of them and submit again. Nothing you typed was written, and nothing of theirs was overwritten. This check is required on every save precisely so a concurrent edit can never be silently lost.',
    area: 'listing', roles: PH, see: 'ph-grid-editing',
    keywords: ['conflict', '409', 'submit', 'overwrite', 'concurrent', 'reload'],
  },
  {
    id: 'faq-system-generated',
    q: 'The history says "(system-generated)". Who actually did it?',
    a: 'Nobody. The Global Indicator fetched automatically from Alias logs as system-generated, and a Final price logs as system-generated for as long as it still equals GI × margin. A name appears only once a person overrode the calculated value.',
    area: 'listing', roles: STAFF, see: 'ph-history',
    keywords: ['system generated', 'history', 'who', 'attribution', 'auto', 'events'],
  },

  // ------------------------------------------------------------------- PO ---
  {
    id: 'faq-po-blank',
    q: 'The reconciliation list is empty but I know we have orders.',
    a: 'That list only shows orders that have reached receiving. Orders still in draft or shipped live on the Purchase Orders overview, which is where you track them and their labels. And an order that matched perfectly closes itself, so it will not be in the queue at all.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'po-overview',
    keywords: ['blank', 'empty', 'reconciliation', 'missing PO', 'draft', 'shipped'],
  },
  {
    id: 'faq-po-autoclose',
    q: 'A purchase order closed itself. Should it have?',
    a: 'Yes, if it was clean: still receiving, intake finished, no boxes left at the supplier, and received exactly matching expected. Anything short, over, blind or mid-intake stays in the queue for a person. Without this, a perfect order sat in the queue forever and the supplier read it as still outstanding.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'reconcile-warehouse',
    keywords: ['auto', 'closed itself', 'reconciled', 'clean', 'automatic'],
  },
  {
    id: 'faq-po-blind',
    q: 'The report says "received blind" and lists everything as Received.',
    a: 'The supplier never gave a manifest, so there is nothing to compare against. Every line is labelled "Received" rather than "Not on PO", because reporting a wall of phantom overages to a supplier who never sent a list is worse than saying plainly that we counted it ourselves.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'po-onbehalf',
    keywords: ['blind', 'no manifest', 'not on PO', 'overage', 'phantom'],
  },
  {
    id: 'faq-po-supplier-told',
    q: 'I wrote five notes on the order. Has the supplier seen them?',
    a: 'Only if you wrote in "Note to the supplier". The thread is internal — it is the audit trail for us. That mix-up is exactly why an amber nudge appears when a resolution has started and the supplier-facing note is still empty, and why every internal comment has a "Send to supplier" button to promote it.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'po-resolution',
    keywords: ['note', 'supplier', 'internal', 'thread', 'comment', 'visible', 'nudge', 'send to supplier'],
  },
  {
    id: 'faq-po-replacement-count',
    q: 'Why does a replacement shipment not appear in "1 of 2 labels shipped"?',
    a: 'Because that number describes the supplier\'s packing job, and a reship is one we created. Counting it would turn their completed "1 of 1" into an unfinished "1 of 2". The same reasoning keeps a replacement\'s declared items out of the expected count and the order\'s unit total: those pairs were already declared on the original manifest and already counted short, so counting them twice would leave the order reading short forever.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'po-resolution',
    keywords: ['replacement', 'reship', 'label count', 'shipped count', 'excluded'],
  },
  {
    id: 'faq-po-replacement-manifest',
    q: 'Can the supplier say what is in a replacement shipment?',
    a: 'Yes. The replacement label is fillable in the supplier portal ("List what you\'re sending"), and PH can enter it on their behalf from PO Overview if the supplier will not. The warehouse then receives the reship against a real checklist instead of scanning it blind. Unlike the supplier\'s own labels, this stays editable until the order is archived — a reship is created already-shipped, so the usual draft/pending window never applies. Declaring it cannot change the shortage on the original order.',
    area: 'po', roles: ['ph_team', 'warehouse', 'supplier', 'admin', 'superadmin'], see: 'po-resolution',
    keywords: ['replacement', 'reship', 'manifest', 'declare', 'on behalf', 'supplier portal', 'checklist'],
  },
  {
    id: 'faq-print-manifest',
    q: 'How do I get a paper list of what is supposed to be in the boxes?',
    a: 'Print the manifest. It is on the PO banner in Receiving (before you unpack), on the PO Reconciliation report, and on the PH Purchase Orders page — all three produce the same PDF. "Per box" gives a page per shipping label, which is the one you carry to the pallet; "Whole order" gives a single list with every tracking number up top. It downloads rather than printing directly, so open the file and use your normal print dialog. Note it shows what the SUPPLIER declared, not what you actually received — a blind receipt has no manifest to print, so the button is not offered.',
    area: 'po', roles: ['warehouse', 'ph_team', 'admin', 'superadmin'], see: 'receive-against-po',
    keywords: ['print', 'manifest', 'paper', 'packing slip', 'pdf', 'per box', 'whole order', 'checklist', 'download'],
  },
  {
    id: 'faq-po-receive-draft',
    q: 'Can I receive a box against an order that still says draft?',
    a: 'Yes, and you often will. Boxes arrive one at a time and a multi-label order stays in draft until the supplier has shipped every label. Only reconciled and archived orders are closed to receiving.',
    area: 'po', roles: WH, see: 'receive-against-po',
    keywords: ['draft', 'receive', 'blocked', 'status', 'shipped', 'reconciled'],
  },
  {
    id: 'faq-po-reopen',
    q: 'I need to receive against an order that is already closed.',
    a: 'Log the reship through the resolution checklist. Adding a replacement label reopens the order for receiving automatically and announces it in the thread — it is never a silent change. Archived orders can also be brought back with "Bring back", which returns them to reconciled with the frozen numbers intact.',
    area: 'po', roles: ['ph_team', 'warehouse', 'admin', 'superadmin'], see: 'po-resolution',
    keywords: ['reopen', 'closed', 'archived', 'bring back', 'unarchive', 'replacement'],
  },

  // ------------------------------------------------------------- supplier ---
  {
    id: 'faq-sup-wrong-portal',
    q: 'It says this portal is for suppliers, or refuses my sign-in.',
    a: 'Supplier accounts work only on the supplier portal, and staff accounts only on the main site. Check which address you are on. If your account was only just approved, that also has to happen before you can sign in at all.',
    area: 'start', roles: SUP, see: 'supplier-signup',
    keywords: ['portal', 'subdomain', 'wrong site', '403', 'sign in', 'refused'],
  },
  {
    id: 'faq-sup-cant-edit',
    q: 'I cannot change the items on a label any more.',
    a: 'The label has been closed for packing. Reopen the box, make the change, and close it again. Once a label is marked shipped it is final.',
    area: 'po', roles: SUP, see: 'supplier-close-ship',
    keywords: ['edit', 'locked', 'packed', 'reopen', 'closed', 'shipped'],
  },
  {
    id: 'faq-sup-entered-for-you',
    q: 'A line says "Entered for you by … Staff". What is that?',
    a: 'We typed it from a list you sent us, so the order still has a manifest even though it did not come through the portal. Check it — if you edit it, the line becomes yours.',
    area: 'po', roles: SUP, see: 'supplier-scanout',
    keywords: ['entered for you', 'on behalf', 'staff', 'manifest', 'attribution'],
  },
  {
    id: 'faq-sup-extra-box',
    q: 'There is a box on my order I never packed.',
    a: 'If it is titled "Replacement shipment", we created it to make good on a shortage. It is not something you missed, and it does not count against your labels.',
    area: 'po', roles: SUP, see: 'supplier-portal-read',
    keywords: ['extra box', 'replacement', 'not mine', 'reship', 'label'],
  },

  // -------------------------------------------------------------- accounts --
  {
    id: 'faq-role-change-delay',
    q: 'I changed someone\'s role but nothing happened for them.',
    a: 'Sessions are self-contained and last about 8 hours, so a role change or a deletion lands at their next sign-in rather than instantly. Have them sign out and back in.',
    area: 'admin', roles: ['admin', 'superadmin'], see: 'admin-check-access',
    keywords: ['role', 'change', 'delay', 'session', 'sign out', 'not applied', 'revoke'],
  },
  {
    id: 'faq-locked-out',
    q: 'Too many wrong passwords and now it will not let me try.',
    a: 'Failed attempts are counted per username and per address over a 15-minute window, then locked out. Wait it out. Hammering the form only keeps the window open.',
    area: 'start', roles: ALL, see: 'password-reset',
    keywords: ['locked out', '429', 'too many attempts', 'throttle', 'wait', 'password'],
  },
  {
    id: 'faq-temp-password-lost',
    q: 'I lost the temporary password before sending it on.',
    a: 'Issue another one. It is shown once and only its hash is kept, so there is nothing to look up — which is the point.',
    area: 'admin', roles: ['admin', 'superadmin'], see: 'admin-check-access',
    keywords: ['temp password', 'lost', 'reissue', 'reset', 'hash', 'once'],
  },
  {
    id: 'faq-must-change',
    q: 'The app will not let me do anything until I change my password.',
    a: 'You signed in with a temporary password an admin issued. Setting your own unlocks everything — the block is enforced on the server too, so there is no way round it.',
    area: 'start', roles: ALL, see: 'password-reset',
    keywords: ['must change', 'forced', 'temp password', 'blocked', '428'],
  },
];
