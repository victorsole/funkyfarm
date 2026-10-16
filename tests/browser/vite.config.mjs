import { fileURLToPath } from 'node:url';
import react from '../../apps/web/node_modules/@vitejs/plugin-react/dist/index.js';

const apiURL = process.env.FUNKYFARM_BROWSER_API_URL;
if (!apiURL || !['127.0.0.1', 'localhost'].includes(new URL(apiURL).hostname)) {
  throw new Error('Browser acceptance requires the isolated loopback API.');
}

export default {
  root: fileURLToPath(new URL('../../apps/web/', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: { '/api': { target: apiURL, changeOrigin: false } },
  },
};
