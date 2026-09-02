// "The app was updated while this tab was open."
//
// Every lazily-loaded chunk statically imports the main bundle, so its filename changes
// on every deploy — a tab left open across one asks the server for a file that no longer
// exists. The warehouse keeps the app open all shift, so this is routine.
//
// It does NOT reload on its own. Receiving, Existing Stock and the counting screens hold
// scanned work that hasn't been saved, and throwing that away to fix a camera or a
// download is a bad trade. The person chooses; the bar just stops the failure from being
// a mystery. Dismissible, because a bar you can't get rid of over an unsaved count is its
// own problem.
import React, { useState } from 'react';

export function AppUpdatedBar() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="app-updated-bar" role="status">
      <span>
        <b>A new version was released.</b> Some things won’t load until this tab is reloaded —
        save anything you’ve scanned first.
      </span>
      <span className="app-updated-actions">
        <button type="button" className="btn sm primary" onClick={() => window.location.reload()}>Reload</button>
        <button type="button" className="btn sm ghost" onClick={() => setHidden(true)}>Later</button>
      </span>
    </div>
  );
}
