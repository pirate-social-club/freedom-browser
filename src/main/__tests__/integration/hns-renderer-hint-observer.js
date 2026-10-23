// Synthetic probe-only observation, attached before a guest can navigate.
const HINT_MESSAGE = /^DNS prefetch triggered for ((?:header|html)-(?:default|private)(?:-r2)?\.(?:hnsprobe|pirate|unlistedprobe))$/;
const MAX_MESSAGES = 64;
const MAX_CONTENTS = 16;

function observeRendererHints(app, { enabled, clock = Date.now }) {
  const started = clock();
  const messages = [];
  const contentsIds = [];
  let overflow = false;
  if (enabled) {
    const existing = app.commandLine.getSwitchValue('blink-settings');
    app.commandLine.appendSwitch('blink-settings',
      [existing, 'logDnsPrefetchAndPreconnect=true'].filter(Boolean).join(','));
    app.on('web-contents-created', (_event, contents) => {
      if (contentsIds.length >= MAX_CONTENTS) {
        overflow = true;
        return;
      }
      contentsIds.push(contents.id);
      contents.on('console-message', (details) => {
        const match = typeof details?.message === 'string' && HINT_MESSAGE.exec(details.message);
        if (!match) return;
        if (messages.length >= MAX_MESSAGES) {
          overflow = true;
          return;
        }
        messages.push({ contentsId: contents.id, name: match[1], ms: clock() - started });
      });
    });
  }
  return { snapshot: () => ({ enabled, overflow, contentsIds: [...contentsIds],
    messages: messages.map((message) => ({ ...message })) }) };
}

module.exports = { observeRendererHints };
