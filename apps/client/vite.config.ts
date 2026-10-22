import { defineConfig } from 'vite-plus'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    rolldownOptions: {
      resolve: {
        extensions: [
          '.web.tsx',
          '.web.ts',
          '.web.jsx',
          '.web.js',
          '.tsx',
          '.ts',
          '.jsx',
          '.js',
          '.json',
        ],
      },
    },
  },
  resolve: {
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.web.jsx',
      '.web.js',
      '.mjs',
      '.js',
      '.ts',
      '.tsx',
      '.json',
    ],
    alias: [
      {
        find: /^@react-native-vector-icons\/material-design-icons$/,
        replacement: new URL('./src/ui/Icon.web.tsx', import.meta.url).pathname,
      },
      { find: /^react-native$/, replacement: 'react-native-web' },
    ],
  },
  define: {
    global: 'globalThis',
    __DEV__: 'false',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  base: './',
  build: { outDir: 'dist' },
})
