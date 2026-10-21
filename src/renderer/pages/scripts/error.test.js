const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'error.js'), 'utf8');

async function loadErrorPage(parameters, registry = null) {
  const elements = Object.fromEntries(
    ['details', 'description', 'title', 'retry-btn'].map((id) => [id, {
      textContent: '', innerHTML: '', hidden: false, onclick: null,
    }])
  );
  const document = { title: '', getElementById: (id) => elements[id] };
  const query = new URLSearchParams(parameters).toString();
  const freedomAPI = {
    getServiceRegistry: jest.fn().mockResolvedValue(registry),
    onServiceRegistryUpdate: jest.fn(),
  };
  const window = {
    location: {
      href: `file:///browser/pages/error.html?${query}`,
      search: `?${query}`,
      reload: jest.fn(),
    },
    freedomAPI,
  };
  vm.runInNewContext(source, { window, document, URL, URLSearchParams });
  await Promise.resolve();
  await Promise.resolve();
  return { elements, document, window, freedomAPI };
}

describe('error page address refusal and Handshake state', () => {
  test.each([
    ['invalid_address', 'Not a valid address'],
    ['unloadable_swarm_hash', "Can't open this address"],
  ])('%s displays the address as text and hides retry', async (error, title) => {
    const address = 'bzz://<img src=x onerror=alert(1)>';
    const page = await loadErrorPage({ error, url: address });
    expect(page.document.title).toBe(title);
    expect(page.elements.title.textContent).toBe(title);
    expect(page.elements.details.textContent).toBe(address);
    expect(page.elements.details.innerHTML).toBe('');
    expect(page.elements['retry-btn'].hidden).toBe(true);
    expect(page.freedomAPI.getServiceRegistry).not.toHaveBeenCalled();
  });

  test('Handshake waiting retains live sync updates and the original retry', async () => {
    const address = 'https://app.pirate/Case?Q=X#Frag';
    const page = await loadErrorPage({ error: 'HNS_NOT_READY', url: address }, {
      hns: { synced: false, height: 42, statusMessage: 'Starting resolver' },
    });
    expect(page.document.title).toBe('Handshake resolver not ready');
    expect(page.elements.details.textContent).toBe(`${address}\n\nStarting resolver`);
    expect(page.elements['retry-btn'].hidden).toBe(false);
    expect(page.freedomAPI.onServiceRegistryUpdate).toHaveBeenCalledTimes(1);
    const [update] = page.freedomAPI.onServiceRegistryUpdate.mock.calls[0];
    update({ hns: { synced: true } });
    expect(page.elements.details.textContent).toContain('Chain synchronized; retrying the requested site.');
    page.elements['retry-btn'].onclick();
    expect(page.window.location.href).toBe(address);
  });

  test.each(['HNS_LOOKUP_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'])(
    '%s retains Handshake failure text and retry',
    async (error) => {
      const address = 'https://fixture-root/';
      const page = await loadErrorPage({ error, url: address });
      expect(page.document.title).toBe('Handshake site unavailable');
      expect(page.elements.details.textContent).toContain(address);
      expect(page.elements['retry-btn'].hidden).toBe(false);
      page.elements['retry-btn'].onclick();
      expect(page.window.location.href).toBe(address);
    }
  );

  test.each(['ERR_CONNECTION_RESET', 'constructor', '__proto__'])(
    '%s follows the generic error path',
    async (error) => {
      const page = await loadErrorPage({ error, url: 'https://example.test/' });
      expect(page.document.title).toBe("Couldn't load this page");
      expect(page.elements.details.textContent).toContain(error);
      expect(page.elements['retry-btn'].hidden).toBe(false);
    }
  );

  test('retry still refuses an executable scheme supplied by the query string', async () => {
    const page = await loadErrorPage({
      error: 'HNS_LOOKUP_FAILED', url: 'https://app.pirate/', retry: 'javascript:alert(1)',
    });
    page.elements['retry-btn'].onclick();
    expect(page.window.location.href).toBe('https://app.pirate/');
  });
});
