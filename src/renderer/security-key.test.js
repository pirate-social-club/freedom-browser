const fs = require('fs');
const path = require('path');
const vm = require('vm');

function page(request) {
  const nodes = {};
  for (const id of ['form', 'pin', 'account', 'origin', 'rp', 'title', 'pin-fields', 'account-fields', 'message', 'cancel']) {
    nodes[id] = { value: '', handlers: {}, options: [], focus: jest.fn(),
      addEventListener(name, callback) { this.handlers[name] = callback; },
      append(option) { this.options.push(option); } };
  }
  const handlers = {};
  const document = { documentElement: { dataset: {} },
    getElementById: (id) => nodes[id], createElement: () => ({}),
    addEventListener: (name, callback) => { handlers[name] = callback; } };
  const respond = jest.fn();
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'security-key.js'), 'utf8'), {
    document, securityKeyPrompt: { onRequest: (callback) => callback(request), respond },
  });
  return { nodes, handlers, document, respond };
}

test('PIN dialog displays native retry count and clears the input before replying', () => {
  const p = page({ kind: 'pin', origin: 'https://news.web3', rp: 'news.web3',
    theme: 'light', attemptsRemaining: 7, error: 'wrong-pin' });
  expect(p.nodes.message.textContent).toContain('7 attempts');
  expect(p.nodes.message.textContent).toContain('not accepted');
  expect(p.nodes.origin.textContent).toBe('https://news.web3');
  expect(p.document.documentElement.dataset.theme).toBe('light');
  p.nodes.pin.value = 'test-pin';
  p.nodes.form.handlers.submit({ preventDefault() {} });
  expect(p.respond).toHaveBeenCalledWith('submit', 'test-pin');
  expect(p.nodes.pin.value).toBe('');
});

test('account labels are text and selection replies with the offered identifier', () => {
  const p = page({ kind: 'account', origin: 'https://news.web3', rp: 'news.web3', theme: 'dark',
    accounts: [{ id: 'credential-a', name: '<img src=x onerror=evil()>' }] });
  expect(p.nodes.account.options[0].textContent).toBe('<img src=x onerror=evil()>');
  expect(p.nodes.account.options[0].innerHTML).toBeUndefined();
  p.nodes.account.value = 'credential-a';
  p.nodes.form.handlers.submit({ preventDefault() {} });
  expect(p.respond).toHaveBeenCalledWith('submit', 'credential-a');
});

test('cancel button and Escape send cancellation', () => {
  const p = page({ kind: 'pin', theme: 'dark', attemptsRemaining: 8 });
  p.nodes.cancel.handlers.click();
  p.handlers.keydown({ key: 'Escape' });
  expect(p.respond.mock.calls).toEqual([['cancel'], ['cancel']]);
});
