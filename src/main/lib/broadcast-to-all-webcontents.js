/**
 * Fan a channel + payload to every live webContents. Used by stores
 * that want "the X table changed" hints to reach both the host
 * renderers and the webview internal pages without each store
 * importing electron's webContents directly.
 *
 * `getAllWebContents` is the catch-all enumerator; individual webContents
 * may have been destroyed since the previous tick, so each send is
 * try/catched. Receivers without a registered listener silently drop.
 */

const { webContents } = require('electron');

function broadcastToAllWebContents(channel, payload) {
  if (!webContents?.getAllWebContents) return;
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send(channel, payload);
    } catch {
      // webContents may be destroyed mid-iteration
    }
  }
}

module.exports = { broadcastToAllWebContents };
