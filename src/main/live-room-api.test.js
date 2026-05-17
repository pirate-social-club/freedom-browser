const IPC = require('../shared/ipc-channels');
const {
  createIpcMainMock,
  createTempUserDataDir,
  removeTempUserDataDir,
} = require('../../test/helpers/main-process-test-utils');
const {
  attachLiveRoom,
  clearPirateAccessToken,
  endLiveRoom,
  getPirateAuthStatus,
  guestAttachLiveRoom,
  hostAttachLiveRoom,
  normalizeApiBase,
  pollPirateDeviceAuth,
  registerLiveRoomApiIpc,
  savePirateAccessToken,
  startPirateDeviceAuth,
} = require('./live-room-api');

describe('live-room-api', () => {
  const originalApiBase = process.env.PIRATE_API_BASE_URL;
  const originalAccessToken = process.env.PIRATE_API_ACCESS_TOKEN;

  afterEach(() => {
    if (originalApiBase === undefined) {
      delete process.env.PIRATE_API_BASE_URL;
    } else {
      process.env.PIRATE_API_BASE_URL = originalApiBase;
    }
    if (originalAccessToken === undefined) {
      delete process.env.PIRATE_API_ACCESS_TOKEN;
    } else {
      process.env.PIRATE_API_ACCESS_TOKEN = originalAccessToken;
    }
    jest.restoreAllMocks();
  });

  test('normalizes allowed Pirate API bases and rejects arbitrary hosts', () => {
    expect(normalizeApiBase('https://api.pirate.sc/')).toBe('https://api.pirate.sc');
    expect(normalizeApiBase('https://api-staging.pirate.sc/v1/')).toBe('https://api-staging.pirate.sc/v1');
    expect(normalizeApiBase('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(() => normalizeApiBase('http://api.pirate.sc')).toThrow('must use https');
    expect(() => normalizeApiBase('https://evil.example')).toThrow('host is not allowed');
  });

  test('host attach posts to the community live-room endpoint', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        runtime: { status: 'attached' },
        jacktrip: { server: 'jt.example', port: 4464 },
      }),
    });

    await expect(hostAttachLiveRoom({
      apiBase: 'https://api-staging.pirate.sc',
      communityId: 'cmt_test',
      liveRoomId: 'lr_test',
      accessToken: 'tok_test',
    }, { fetch })).resolves.toEqual({
      runtime: { status: 'attached' },
      jacktrip: { server: 'jt.example', port: 4464 },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api-staging.pirate.sc/communities/cmt_test/live-rooms/lr_test/host_attach',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok_test',
          'content-type': 'application/json',
        }),
      })
    );
  });

  test('guest attach posts to the community live-room guest endpoint', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        runtime: { status: 'attached', seat: 'guest' },
        jacktrip: { server: 'jt.example', port: 4464 },
      }),
    });

    await expect(guestAttachLiveRoom({
      apiBase: 'https://api-staging.pirate.sc',
      communityId: 'cmt_test',
      liveRoomId: 'lr_test',
      accessToken: 'tok_test',
    }, { fetch })).resolves.toEqual({
      runtime: { status: 'attached', seat: 'guest' },
      jacktrip: { server: 'jt.example', port: 4464 },
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api-staging.pirate.sc/communities/cmt_test/live-rooms/lr_test/guest_attach',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok_test',
          'content-type': 'application/json',
        }),
      })
    );
  });

  test('generic attach falls back from host to guest when the user is not the host', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: jest.fn().mockResolvedValue({ error: 'Live room not found' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          runtime: { status: 'attached', seat: 'guest' },
        }),
      });

    await expect(attachLiveRoom({
      apiBase: 'https://api-staging.pirate.sc',
      communityId: 'cmt_test',
      liveRoomId: 'lr_test',
      accessToken: 'tok_test',
    }, { fetch })).resolves.toEqual({
      runtime: { status: 'attached', seat: 'guest' },
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://api-staging.pirate.sc/communities/cmt_test/live-rooms/lr_test/host_attach',
      expect.any(Object)
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://api-staging.pirate.sc/communities/cmt_test/live-rooms/lr_test/guest_attach',
      expect.any(Object)
    );
  });

  test('host attach can use env access token', async () => {
    process.env.PIRATE_API_ACCESS_TOKEN = 'env_token';
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ ok: true }),
    });

    await expect(hostAttachLiveRoom({
      apiBase: 'http://localhost:8787',
      communityId: 'community',
      roomId: 'lr_test',
    }, { fetch })).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8787/communities/community/live-rooms/lr_test/host_attach',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer env_token',
        }),
      })
    );
  });

  test('host attach can use a stored secure access token', async () => {
    const userDataDir = createTempUserDataDir('freedom-live-room-token-');
    const safeStorage = {
      isEncryptionAvailable: jest.fn(() => true),
      encryptString: jest.fn((value) => Buffer.from(`enc:${value}`)),
      decryptString: jest.fn((buffer) => buffer.toString('utf8').replace(/^enc:/, '')),
    };
    const authStorage = {
      app: { getPath: jest.fn(() => userDataDir) },
      safeStorage,
    };
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ ok: true }),
    });

    try {
      expect(getPirateAuthStatus(authStorage)).toEqual(expect.objectContaining({
        secureStorageAvailable: true,
        hasStoredAccessToken: false,
        authorized: false,
      }));
      expect(savePirateAccessToken('Bearer stored_token', authStorage)).toEqual(expect.objectContaining({
        secureStorageAvailable: true,
        hasStoredAccessToken: true,
        authorized: true,
      }));

      await expect(hostAttachLiveRoom({
        apiBase: 'http://localhost:8787',
        communityId: 'community',
        roomId: 'lr_test',
      }, { fetch, authStorage })).resolves.toEqual({ ok: true });

      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:8787/communities/community/live-rooms/lr_test/host_attach',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer stored_token',
          }),
        })
      );
      expect(clearPirateAccessToken(authStorage)).toEqual(expect.objectContaining({
        secureStorageAvailable: true,
        hasStoredAccessToken: false,
        authorized: false,
      }));
    } finally {
      removeTempUserDataDir(userDataDir);
    }
  });

  test('rejects oversized room identifiers before making requests', async () => {
    const fetch = jest.fn();
    const oversizedId = `cmt_${'x'.repeat(161)}`;

    await expect(hostAttachLiveRoom({
      apiBase: 'https://api.pirate.sc',
      communityId: oversizedId,
      liveRoomId: 'lr_test',
      accessToken: 'tok_test',
    }, { fetch })).rejects.toThrow('communityId is too long');

    expect(fetch).not.toHaveBeenCalled();
  });

  test('end room posts to the community live-room end endpoint', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        id: 'lr_test',
        status: 'ended',
      }),
    });

    await expect(endLiveRoom({
      apiBase: 'https://api-staging.pirate.sc',
      communityId: 'cmt_test',
      liveRoomId: 'lr_test',
      accessToken: 'tok_test',
    }, { fetch })).resolves.toEqual({
      id: 'lr_test',
      status: 'ended',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://api-staging.pirate.sc/communities/cmt_test/live-rooms/lr_test/end',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok_test',
          'content-type': 'application/json',
        }),
      })
    );
  });

  test('device auth starts in the browser and stores tokens after polling succeeds', async () => {
    const userDataDir = createTempUserDataDir('freedom-live-room-device-auth-');
    const safeStorage = {
      isEncryptionAvailable: jest.fn(() => true),
      encryptString: jest.fn((value) => Buffer.from(`enc:${value}`)),
      decryptString: jest.fn((buffer) => buffer.toString('utf8').replace(/^enc:/, '')),
    };
    const shell = {
      openExternal: jest.fn().mockResolvedValue(undefined),
    };
    const authStorage = {
      app: { getPath: jest.fn(() => userDataDir) },
      safeStorage,
      shell,
    };
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          device_code: 'pdev_abc',
          user_code: 'PTR-ABCD-2345',
          verification_uri: 'http://localhost:5173/authorize-device',
          verification_uri_complete: 'http://localhost:5173/authorize-device?user_code=PTR-ABCD-2345',
          expires_in: 900,
          interval: 5,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: jest.fn().mockResolvedValue({
          error: 'authorization_pending',
          interval: 5,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          access_token: 'access_1',
          refresh_token: 'refresh_1',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_expires_in: 86400,
          scope: 'live_room:attach live_room:manage',
        }),
      });

    try {
      await expect(startPirateDeviceAuth({
        apiBase: 'http://localhost:8787',
      }, { fetch, authStorage })).resolves.toEqual(expect.objectContaining({
        device_code: 'pdev_abc',
        user_code: 'PTR-ABCD-2345',
      }));
      expect(shell.openExternal).toHaveBeenCalledWith('http://localhost:5173/authorize-device?user_code=PTR-ABCD-2345');

      await expect(pollPirateDeviceAuth({
        apiBase: 'http://localhost:8787',
        deviceCode: 'pdev_abc',
      }, { fetch, authStorage })).resolves.toEqual(expect.objectContaining({
        error: 'authorization_pending',
      }));

      await expect(pollPirateDeviceAuth({
        apiBase: 'http://localhost:8787',
        deviceCode: 'pdev_abc',
      }, { fetch, authStorage })).resolves.toEqual(expect.objectContaining({
        access_token: '<stored>',
        refresh_token: '<stored>',
        auth: expect.objectContaining({
          authorized: true,
          hasStoredRefreshToken: true,
        }),
      }));
    } finally {
      removeTempUserDataDir(userDataDir);
    }
  });

  test('registers live-room API IPC handlers', async () => {
    const ipcMain = createIpcMainMock();
    registerLiveRoomApiIpc(ipcMain);
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_LIVE_ROOM_ATTACH, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_LIVE_ROOM_HOST_ATTACH, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_LIVE_ROOM_GUEST_ATTACH, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_LIVE_ROOM_END, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_AUTH_GET_STATUS, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_AUTH_START_DEVICE, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_AUTH_POLL_DEVICE, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_AUTH_SAVE_ACCESS_TOKEN, expect.any(Function));
    expect(ipcMain.handle).toHaveBeenCalledWith(IPC.PIRATE_AUTH_CLEAR_ACCESS_TOKEN, expect.any(Function));
  });
});
