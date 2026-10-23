const { runPageScript } = require('../../../test/helpers/page-script-harness');

const IDS = { title: 'h1', description: 'p', status: 'div', details: 'dl', hint: 'p' };

async function openResult(params) {
  const { document, elements } = await runPageScript('space-browser', {
    ids: IDS,
    search: `?${new URLSearchParams(params)}`,
  });
  const rows = elements.details.childNodes.map((row) =>
    row.childNodes.map((cell) => cell.textContent)
  );
  return { document, elements, rows };
}

describe('Spaces result page', () => {
  test('a verified Space without a website says so, with the block it was verified at', async () => {
    const { elements, rows, document } = await openResult({
      handle: '@yahoo',
      type: 'refused',
      reason: 'NO_WEBSITE_RECORD',
      anchorHeight: '970596',
    });
    expect(elements.status.textContent).toBe('Website not published');
    expect(elements.description.textContent).toBe(
      'The owner has not signed a website for this name.'
    );
    expect(rows).toEqual([
      ['Space', '@yahoo'],
      ['Verified at Bitcoin block', '970596'],
    ]);
    expect(elements.hint.textContent).toBe('');
    expect(document.htmlWrites).toEqual([]);
  });

  test('a member whose finality quorum is missing is refused without asserting nonexistence', async () => {
    const { elements, rows, document } = await openResult({
      handle: 'member@example', type: 'refused', reason: 'MEMBER_NOT_FINAL', anchorHeight: '145',
    });
    expect(elements.status.textContent).toBe('Finality not confirmed');
    expect(elements.description.textContent).toBe(
      'Freedom could not confirm that this name is finalized on Bitcoin. Try again later.'
    );
    expect(rows).toEqual([['Space', 'member@example'], ['Verified at Bitcoin block', '145']]);
    expect(document.htmlWrites).toEqual([]);
  });

  test('an error shows its detail as text and suggests a retry', async () => {
    const { elements, rows, document } = await openResult({
      handle: '@yahoo',
      type: 'error',
      reason: 'ANCHORS_UNAVAILABLE',
      message: '<img src=x onerror=alert(1)>',
      anchorHeight: '1; DROP',
    });
    expect(elements.status.textContent).toBe('Cannot verify');
    expect(rows).toEqual([
      ['Space', '@yahoo'],
      ['Detail', '<img src=x onerror=alert(1)>'],
    ]);
    expect(elements.hint.textContent).toBe('Try again in a moment.');
    expect(document.htmlWrites).toEqual([]);
  });

  test('a refusal never shows a message, and an unknown reason still reads sensibly', async () => {
    const { elements, rows } = await openResult({
      handle: 'a@b',
      type: 'refused',
      reason: 'SOMETHING_NEW',
      message: 'x',
    });
    expect(elements.status.textContent).toBe('Not opened');
    expect(rows).toEqual([['Space', 'a@b']]);
  });
});
