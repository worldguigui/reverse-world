import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 使用相对路径，构建产物可以直接双击或放到任意子目录下打开
  base: './',
  server: {
    port: 5173,
    host: true,
    // 开发时把云端存档请求转给本地 Node；生产环境由 nginx 做同样的反代
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
