import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 使用相对路径，构建产物可以直接双击或放到任意子目录下打开
  base: './',
  server: {
    port: 5173,
    host: true,
  },
});
