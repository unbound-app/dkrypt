import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    __DKRYPT_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [tailwindcss(), svelte()],
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rolldownOptions: {
      checks: {
        pluginTimings: false,
      },
      output: {
        codeSplitting: {
          groups: [
            { name: 'svelte', test: /node_modules[\\/]svelte[\\/]/, priority: 30 },
            { name: 'bits-ui', test: /node_modules[\\/]bits-ui[\\/]/, priority: 20 },
            { name: 'icons', test: /node_modules[\\/]lucide-svelte[\\/]/, priority: 20 },
            { name: 'paddle', test: /node_modules[\\/]@paddle[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10, minSize: 20_000 },
          ],
        },
      },
    },
  },
});
