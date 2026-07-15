import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
