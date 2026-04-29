import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#07111f",
        surface: "#0d1b2e",
        border: "#1f3148",
        muted: "#8da2bb",
      },
    },
  },
  plugins: [],
};

export default config;
