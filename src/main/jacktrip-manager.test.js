const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const ORIGINAL_PATH = process.env.PATH;

function createProcessMock(options = {}) {
  const listeners = new Map();
  const onceListeners = new Map();
  const stdoutListeners = new Map();
  const stderrListeners = new Map();
  const emitAll = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };
  const proc = {
    stdout: {
      on: jest.fn((event, handler) => {
        if (!stdoutListeners.has(event)) stdoutListeners.set(event, []);
        stdoutListeners.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrListeners.has(event)) stderrListeners.set(event, []);
        stderrListeners.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) onceListeners.set(event, []);
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitAll(listeners, event, args);
      const handlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      handlers.forEach((handler) => handler(...args));
    },
    kill: jest.fn((signal) => {
      proc.lastSignal = signal;
      if (options.autoCloseOnKill !== false) {
        proc.emit('close', 0);
      }
      return true;
    }),
  };
  return proc;
}

function createWindowMock() {
  return {
    webContents: {
      send: jest.fn(),
    },
  };
}

function loadJacktripManager(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = options.app || createAppMock({
    isPackaged: options.isPackaged ?? false,
    userDataDir: options.userDataDir || '/tmp/freedom-user-data',
  });
  const windows = options.windows || [];
  const BrowserWindow = {
    getAllWindows: jest.fn(() => windows),
  };
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();
  const spawnedProcesses = [];
  const execCalls = [];
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(options.processOptions || {});
    proc.binary = binary;
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });
  const execFile = jest.fn((binary, args = [], execOptions = {}, callback) => {
    const cb = typeof execOptions === 'function' ? execOptions : callback;
    const opts = typeof execOptions === 'function' ? {} : execOptions;
    execCalls.push({ binary, args, options: opts });
    const response = typeof options.execFileResponse === 'function'
      ? options.execFileResponse(binary, args, opts)
      : { stdout: '', stderr: '' };
    cb(response.error || null, response.stdout || '', response.stderr || '');
  });

  const binDir = options.binDir || '/mock/bin';
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'jacktrip', 'setup-duet-audio-source-linux.sh');
  const binaries = new Set(
    options.binaries || [
      path.join(binDir, 'jacktrip'),
      path.join(binDir, 'jack_lsp'),
      path.join(binDir, 'jack_connect'),
      path.join(binDir, 'jack_disconnect'),
      scriptPath,
    ]
  );
  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') return options.existsSync(target);
      return binaries.has(target);
    }),
  };

  process.env.PATH = binDir;
  const { mod } = loadMainModule(require.resolve('./jacktrip-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      child_process: () => ({
        execFile,
        spawn,
      }),
      fs: () => fsMock,
      [require.resolve('./logger')]: () => log,
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          EXTERNAL: 'external',
          NONE: 'none',
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
    },
  });
  return {
    clearErrorState,
    clearService,
    execCalls,
    execFile,
    fsMock,
    ipcMain,
    log,
    mod,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    updateService,
    windows,
  };
}

describe('jacktrip-manager', () => {
  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports dependency state', async () => {
    const ctx = loadJacktripManager();

    ctx.mod.registerJacktripIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
      IPC.JACKTRIP_CHECK_DEPS,
      IPC.JACKTRIP_CONNECT,
      IPC.JACKTRIP_DISCONNECT,
      IPC.JACKTRIP_GET_STATUS,
      IPC.JACKTRIP_LIST_PORTS,
      IPC.JACKTRIP_RESTORE_AUDIO,
      IPC.JACKTRIP_SETUP_AUDIO,
      IPC.JACKTRIP_START_LOCAL_SERVER,
      IPC.JACKTRIP_STOP_LOCAL_SERVER,
    ].sort());
    await expect(ctx.ipcMain.invoke(IPC.JACKTRIP_GET_STATUS)).resolves.toEqual(
      expect.objectContaining({
        status: 'disconnected',
        error: null,
      })
    );
    await expect(ctx.ipcMain.invoke(IPC.JACKTRIP_CHECK_DEPS)).resolves.toEqual(
      expect.objectContaining({
        available: true,
        jacktripBinary: '/mock/bin/jacktrip',
      })
    );
  });

  test('connect spawns jacktrip with room endpoint and broadcasts connected state', async () => {
    jest.useFakeTimers();
    const window = createWindowMock();
    const ctx = loadJacktripManager({ windows: [window] });

    const status = await ctx.mod.connect({ server: '127.0.0.1', port: 4464 });
    expect(status.status).toBe('connecting');
    expect(ctx.spawn).toHaveBeenCalledWith('/mock/bin/jacktrip', [
      '-c',
      '127.0.0.1',
      '-P',
      '4464',
      '-B',
      '4465',
      '--bufstrategy',
      '3',
      '-q',
      '4',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    await jest.advanceTimersByTimeAsync(250);

    expect(ctx.updateService).toHaveBeenCalledWith('jacktrip', expect.objectContaining({
      connected: true,
      server: '127.0.0.1',
      port: 4464,
    }));
    expect(ctx.setStatusMessage).toHaveBeenLastCalledWith('jacktrip', 'Connected: 127.0.0.1:4464');
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      IPC.JACKTRIP_STATUS_UPDATE,
      expect.objectContaining({
        status: 'connected',
        connection: {
          server: '127.0.0.1',
          port: 4464,
          bindPort: 4465,
        },
      })
    );
  });

  test('disconnect terminates the managed client process and clears registry state', async () => {
    jest.useFakeTimers();
    const ctx = loadJacktripManager();
    await ctx.mod.connect({ server: 'room.example', port: 4464 });
    await jest.advanceTimersByTimeAsync(250);

    const status = await ctx.mod.disconnect();

    expect(ctx.spawnedProcesses[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(status.status).toBe('disconnected');
    expect(ctx.clearService).toHaveBeenCalledWith('jacktrip');
  });

  test('listPorts delegates to jack_lsp and trims empty output', async () => {
    const ctx = loadJacktripManager({
      execFileResponse: () => ({
        stdout: 'system:capture_1\n\njacktrip:receive_1\n',
      }),
    });

    await expect(ctx.mod.listPorts()).resolves.toEqual(['system:capture_1', 'jacktrip:receive_1']);
    expect(ctx.execCalls[0]).toEqual(expect.objectContaining({
      binary: '/mock/bin/jack_lsp',
      args: [],
    }));
  });

  test('setupAudio parses key-value script output and updates audio status', async () => {
    const ctx = loadJacktripManager({
      execFileResponse: () => ({
        stdout: [
          'status=ok',
          'backend=pactl',
          'sink_name=jacktrip_duet',
          'sink_description=JackTrip Duet Sink',
          'source_name=jacktrip_duet_input',
          'browser_pick_label=JackTrip Duet Mic',
          'created_sink=1',
          'moved_inputs_count=2',
          'set_default_source_requested=1',
          'set_default_source=1',
          'default_source_after=jacktrip_duet_input',
          'default_source_is_duet=1',
          'recommended_restore_source=alsa_input.usb',
          'recommended_restore_label=USB Mic',
          '',
        ].join('\n'),
      }),
    });

    if (process.platform !== 'linux') {
      await expect(ctx.mod.setupAudio()).rejects.toThrow('Linux-only');
      return;
    }

    const result = await ctx.mod.setupAudio({ setDefaultSource: true });

    expect(result).toEqual(expect.objectContaining({
      sourceName: 'jacktrip_duet_input',
      sourceLabel: 'JackTrip Duet Mic',
      movedInputsCount: 2,
      defaultSourceIsDuet: true,
    }));
    expect(ctx.execCalls[0].binary).toBe('bash');
    expect(ctx.execCalls[0].options.env.DUET_SET_DEFAULT_SOURCE).toBe('1');
    expect(ctx.updateService).toHaveBeenCalledWith('jacktrip', expect.objectContaining({
      audioSourceName: 'jacktrip_duet_input',
      audioSourceLabel: 'JackTrip Duet Mic',
    }));
  });
});
