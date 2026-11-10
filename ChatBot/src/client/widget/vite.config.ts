import { defineConfig } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, "widget.ts"),
      name: "CafeChatbot",
      fileName: "cafe-chatbot-widget",
      formats: ["iife"],
    },
    outDir: path.resolve(__dirname, "../../../public/widget"),
    emptyOutDir: true,
  },
});
