import '@testing-library/jest-dom/vitest';

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/tmp/aristotle-reader'),
  resourceDir: vi.fn(async () => '/tmp/aristotle-reader/resources'),
  join: vi.fn(async (...parts: string[]) => parts.join('/').replace(/\/+/g, '/')),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(async () => null),
  open: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({ onDragDropEvent: vi.fn(async () => () => undefined) })),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => undefined),
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
