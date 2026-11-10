/** Tailwind CSS configuration (v3). */
module.exports = {
  content: ["./src/client/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brown: {
          900: "#3e2723",
          800: "#4e342e",
          700: "#5d4037",
          600: "#6d4c41",
          500: "#795548",
          400: "#8d6e63",
          50: "#efebe9",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        serif: ["Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
