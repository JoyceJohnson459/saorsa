<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="paths[name] ?? paths.activity"
  />
</template>

<script setup lang="ts">
// Line icons from the Saorsa design (static markup only, never user input).
withDefaults(defineProps<{ name: string; size?: number; stroke?: number }>(), { size: 18, stroke: 1.75 })

const paths: Record<string, string> = {
  "layout-dashboard":
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m17-6a4 4 0 0 1 3 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7a4 4 0 0 1 0 8"/>',
  cpu: '<rect width="14" height="14" x="5" y="5" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M19 9h4m-4 5h4M1 9h4m-4 5h4"/>',
  chart: '<path d="M3 3v18h18M7 16l4-5 4 2 6-8"/>',
  "shield-alert": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M12 8v5m0 4h.01"/>',
  "shield-check": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  wallet: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M17 14h5M2 8h20"/>',
  settings:
    '<path d="M12 2 14 5l3-.3 2 3-1.7 2.3 1 3 2.7 1.2-1.5 3.3-3.1-.2-2.1 2.3-2.3 1.5-2.3-1.5-2.1-2.3-3.1.2L3 14.2l2.7-1.2 1-3L5 7.7l2-3L10 5Z"/><circle cx="12" cy="12" r="3"/>',
  command: '<path d="M9 7V5a2 2 0 1 0-2 2h2Zm0 0h6m0 0h2a2 2 0 1 0-2-2v2Zm0 0v10m0 0v2a2 2 0 1 0 2-2h-2Zm0 0H9m0 0H7a2 2 0 1 0 2 2v-2ZM9 7v10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  "chevrons-up-down": '<path d="m7 9 5-5 5 5m-10 6 5 5 5-5"/>',
  download: '<path d="M12 2v13m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  zap: '<path d="m13 2-9 12h7l-1 8 10-12h-7V2Z"/>',
  activity: '<path d="M2 12h5l3-7 4 14 3-7h5"/>',
  "arrow-up-right": '<path d="M7 17 17 7M7 7h10v10"/>',
  "arrow-down-right": '<path d="M7 7l10 10M17 7v10H7"/>',
  "arrow-right": '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 13 8-13 8V4Z"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  "user-plus": '<path d="M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm11-3v8m-4-4h8"/>',
  "key-round": '<circle cx="7" cy="15" r="5"/><path d="m11 11 9-9 2 2-3 3 2 2-3 3-2-2-2 2"/>',
  "sliders-horizontal": '<path d="M3 6h7m4 0h7M3 18h7m4 0h7"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="18" r="2"/>',
  check: '<path d="m4 12 5 5 11-11"/>',
  x: '<path d="M5 5l14 14M19 5 5 19"/>',
  ellipsis: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  home: '<path d="m3 11 9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 6 10 7 10-7"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/>',
  moon: '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10Z"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.5 3.5-7 8-7s8 2.5 8 7"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  terminal: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m6 9 3 3-3 3m5 0h6"/>',
}
</script>
