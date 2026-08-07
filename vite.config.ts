import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  base: '/typhoon-prediction/', // github仓库名称
  plugins: [vue()],
  server: {
    host: true,
    port: 5173,
  },
})
