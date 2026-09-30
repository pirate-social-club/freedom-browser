const fs = require('fs');
const os = require('os');
const path = require('path');
const { installHnsCheckpoint } = require('./hns-checkpoint');

const bundledPath = path.join(__dirname, '../../assets/hns/checkpoint_main.dat');

test('installs the pinned checkpoint only in a fresh profile', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freedom-checkpoint-test-'));
  expect(installHnsCheckpoint(bundledPath, dataDir)).toBe(true);
  const destination = path.join(dataDir, 'hnsd/checkpoint_main.dat');
  expect(fs.readFileSync(destination)).toEqual(fs.readFileSync(bundledPath));
  const saved = Buffer.from('existing profile state');
  fs.writeFileSync(destination, saved);
  expect(installHnsCheckpoint(bundledPath, dataDir)).toBe(false);
  expect(fs.readFileSync(destination)).toEqual(saved);
});

test('rejects a corrupt bundle before creating profile state', () => {
  const checkpoint = Buffer.from(fs.readFileSync(bundledPath));
  checkpoint[checkpoint.length - 1] ^= 1;
  const fsImpl = { readFileSync: () => checkpoint, mkdirSync: jest.fn() };
  expect(() => installHnsCheckpoint(bundledPath, '/unused', fsImpl)).toThrow('integrity');
  expect(fsImpl.mkdirSync).not.toHaveBeenCalled();
});

test('preserves a checkpoint created concurrently', () => {
  const fsImpl = {
    readFileSync: fs.readFileSync, mkdirSync: jest.fn(), existsSync: () => false,
    writeFileSync: jest.fn(() => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }),
  };
  expect(installHnsCheckpoint(bundledPath, '/unused', fsImpl)).toBe(false);
  expect(fsImpl.writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), { flag: 'wx', mode: 0o600 });
});
