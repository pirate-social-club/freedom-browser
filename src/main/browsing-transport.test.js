jest.mock('electron', () => ({
  BrowserWindow: { fromWebContents: jest.fn() },
  session: { defaultSession: { name: 'default' }, fromPartition: jest.fn() },
}));
jest.mock('./private/private-windows', () => ({
  getPartitionForWebContents: jest.fn(() => null),
  isPrivateWebContents: jest.fn(() => false),
}));
const mockLogError = jest.fn();
jest.mock('./logger', () => ({ error: (...args) => mockLogError(...args) }));

const { BrowserWindow, session } = require('electron');
const privateWindows = require('./private/private-windows');
const { runWithPrivateLogContext } = require('./private/private-log-context');
const {
  browsingSessionFor,
  currentBrowsingSession,
  isBrowsingSessionRetired,
  onBrowsingSessionRetired,
  requireBrowsingSession,
  retireBrowsingSession,
  runWithBrowsingSession,
  sessionKey,
} = require('./browsing-transport');

const sender = (overrides = {}) => ({ isDestroyed: () => false, ...overrides });

beforeEach(() => {
  BrowserWindow.fromWebContents.mockReset().mockReturnValue({ id: 1 });
  privateWindows.getPartitionForWebContents.mockReset().mockReturnValue(null);
  privateWindows.isPrivateWebContents.mockReset().mockReturnValue(false);
  session.fromPartition.mockReset().mockImplementation((partition) => ({ partition }));
  mockLogError.mockReset();
});

describe('the session a sender browses in', () => {
  test('a normal window browses in the default session', () => {
    expect(browsingSessionFor(sender())).toBe(session.defaultSession);
  });

  test("a private window uses its partition's session, not its chrome's", () => {
    privateWindows.getPartitionForWebContents.mockReturnValue('private-123');
    privateWindows.isPrivateWebContents.mockReturnValue(true);
    expect(browsingSessionFor(sender())).toEqual({ partition: 'private-123' });
  });

  // Never the default session: that is where a private window's lookups must
  // not go.
  test('a private window whose partition is gone gets none', () => {
    privateWindows.isPrivateWebContents.mockReturnValue(true);
    expect(browsingSessionFor(sender())).toBeNull();
  });

  test('a destroyed sender, or one without a window, gets none', () => {
    expect(browsingSessionFor(sender({ isDestroyed: () => true }))).toBeNull();
    BrowserWindow.fromWebContents.mockReturnValue(null);
    expect(browsingSessionFor(sender())).toBeNull();
    BrowserWindow.fromWebContents.mockImplementation(() => {
      throw new Error('Object has been destroyed');
    });
    expect(browsingSessionFor(sender())).toBeNull();
    expect(browsingSessionFor(null)).toBeNull();
  });
});

describe('session keys', () => {
  test('are stable per Session object and distinct between them', () => {
    const a = { partition: 'private-a' };
    const b = { partition: 'private-b' };
    expect(sessionKey(a)).toBe(sessionKey(a));
    expect(sessionKey(b)).toBe(sessionKey(b));
    expect(sessionKey(a)).not.toBe(sessionKey(b));
    expect(sessionKey(session.defaultSession)).toBe('default');
    expect(sessionKey(a)).not.toBe('default');
  });

  // The key is the object's identity, never something a renderer could name.
  test('do not derive from the partition name', () => {
    const first = { partition: 'private-same' };
    const second = { partition: 'private-same' };
    expect(sessionKey(first)).not.toBe(sessionKey(second));
    expect(sessionKey(first)).not.toContain('private-same');
  });
});

describe('the session a request is dialled on', () => {
  test('is the one the entry point named, across awaits and timers', async () => {
    const target = { partition: 'private-x' };
    const seen = await runWithBrowsingSession(target, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      return requireBrowsingSession();
    });
    expect(seen).toBe(target);
    expect(currentBrowsingSession()).toBeNull();
  });

  test('is the default session for a caller with no browsing context', () => {
    expect(requireBrowsingSession()).toBe(session.defaultSession);
  });

  test('is refused to a private caller that lost its session', () => {
    runWithPrivateLogContext(true, () => {
      expect(() => requireBrowsingSession()).toThrow(
        expect.objectContaining({ code: 'SESSION_UNAVAILABLE' })
      );
      expect(runWithBrowsingSession({ partition: 'p' }, requireBrowsingSession)).toEqual({
        partition: 'p',
      });
    });
  });

  test('a null session clears an outer one rather than inheriting it', () => {
    runWithBrowsingSession({ partition: 'outer' }, () => {
      runWithBrowsingSession(null, () => {
        expect(currentBrowsingSession()).toBeNull();
        expect(requireBrowsingSession()).toBe(session.defaultSession);
      });
    });
  });
});

describe('session retirement', () => {
  test('notifies each listener once, and nothing more is dialled on the session', () => {
    const target = { partition: 'private-closing' };
    const listener = jest.fn();
    const unsubscribe = onBrowsingSessionRetired(listener);
    try {
      retireBrowsingSession(target);
      retireBrowsingSession(target);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(target);
      expect(isBrowsingSessionRetired(target)).toBe(true);
      expect(() => runWithBrowsingSession(target, requireBrowsingSession)).toThrow(
        expect.objectContaining({ code: 'SESSION_UNAVAILABLE' })
      );
    } finally {
      unsubscribe();
    }
  });

  test('a failing listener does not stop the others', () => {
    const broken = onBrowsingSessionRetired(() => {
      throw new Error('boom');
    });
    const listener = jest.fn();
    const unsubscribe = onBrowsingSessionRetired(listener);
    try {
      retireBrowsingSession({ partition: 'private-other' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        '[browsing-transport] session retirement listener failed:',
        'boom'
      );
    } finally {
      broken();
      unsubscribe();
    }
  });

  test('never retires the default session, and an unsubscribed listener hears nothing', () => {
    const listener = jest.fn();
    onBrowsingSessionRetired(listener)();
    retireBrowsingSession(session.defaultSession);
    retireBrowsingSession({ partition: 'private-late' });
    expect(isBrowsingSessionRetired(session.defaultSession)).toBe(false);
    expect(requireBrowsingSession()).toBe(session.defaultSession);
    expect(listener).not.toHaveBeenCalled();
  });
});
