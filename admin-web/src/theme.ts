import { ref } from "vue"

type Mode = "light" | "dark" | "system"
const stored = (() => {
  try {
    // The Saorsa design is dark-first; light remains available from the theme menu.
    return (localStorage.getItem("teamos-theme") as Mode | null) ?? "dark"
  } catch {
    return "dark" as Mode
  }
})()
export const themeMode = ref<Mode>(stored)
export const isDark = ref(false)

export function applyTheme(mode: Mode = themeMode.value) {
  themeMode.value = mode
  try {
    localStorage.setItem("teamos-theme", mode)
  } catch {}
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  isDark.value = dark
  document.documentElement.classList.toggle("dark", dark)
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeMode.value === "system") applyTheme("system")
})
