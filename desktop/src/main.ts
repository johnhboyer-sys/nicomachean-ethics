// Desktop entry point. Order matters: the data layer must decide its root
// before any component module calls a data.ts fetch helper — helpers read the
// root lazily, but fetches fired during component init would race an async
// override, so we simply finish initDataLayer() first.
import '@fontsource/cardo/400.css';
import '@fontsource/cardo/400-italic.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/600.css';
import '@shared/styles/global.css';
import './desktop.css';
import { mount } from 'svelte';
import { initDataLayer } from './lib/runtime';
import { loadImports } from './lib/imports';
import App from './App.svelte';

const info = await initDataLayer();
// Imported translations must be registered before the Reader mounts — it
// resolves its translation list once, at component init.
await loadImports().catch((e: unknown) => {
  console.error('Imported translations could not be loaded:', e);
  return 0;
});

mount(App, {
  target: document.getElementById('app')!,
  props: { dataLayer: info },
});
