<template>
  <main class="login-shell">
    <section class="hero" aria-label="Saorsa">
      <router-link to="/" class="logo" aria-label="Saorsa">
        <logo :size="43" />
        <span class="logo-word">Saorsa<small>AI DEVELOPMENT UNDER CONTROL</small></span>
      </router-link>
      <div class="hero-body">
        <div class="mini-label">ENTERPRISE INTELLIGENCE / CONTROLLED</div>
        <h1>让 AI 编程<br /><em>更可控</em>、更安全<br />更高效<span class="dot">.</span></h1>
        <p class="subtitle">统一模型与密钥，清晰追踪成员用量、项目成本与风险事件。让团队专注创造，让治理隐于无形。</p>
        <div class="feature-tags">
          <span><icon name="chart" :size="13" /> 实时观测</span>
          <span><icon name="shield-check" :size="13" /> 安全治理</span>
          <span><icon name="activity" :size="13" /> 成本透明</span>
        </div>
      </div>
      <div class="orbit-wrap" aria-hidden="true">
        <svg class="orbit" viewBox="0 0 800 800" fill="none">
          <defs>
            <radialGradient id="tos-halo">
              <stop stop-color="#55f68a" stop-opacity=".22" />
              <stop offset=".6" stop-color="#16a34a" stop-opacity=".07" />
              <stop offset="1" stop-color="#071119" stop-opacity="0" />
            </radialGradient>
            <linearGradient id="tos-ring" x1="0" y1="0" x2="800" y2="750">
              <stop stop-color="#55f68a" stop-opacity="0" />
              <stop offset=".55" stop-color="#55f68a" stop-opacity=".67" />
              <stop offset="1" stop-color="#9be7eb" stop-opacity=".10" />
            </linearGradient>
            <filter id="tos-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="5" result="g" />
              <feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          <circle cx="400" cy="400" r="360" fill="url(#tos-halo)" />
          <g class="orbit-core">
            <circle class="orb-ring" cx="400" cy="400" r="318" />
            <circle class="orb-ring" cx="400" cy="400" r="278" />
            <circle class="orb-ring bright" cx="400" cy="400" r="233" />
            <ellipse class="orb-inner" cx="400" cy="400" rx="312" ry="108" transform="rotate(-28 400 400)" />
            <ellipse class="orb-inner" cx="400" cy="400" rx="312" ry="108" transform="rotate(35 400 400)" />
            <ellipse class="orb-inner" cx="400" cy="400" rx="310" ry="108" transform="rotate(82 400 400)" />
            <ellipse class="orb-ring" cx="400" cy="400" rx="304" ry="156" transform="rotate(-52 400 400)" />
            <path d="M112 340c154-149 319-155 563 130" stroke="#a2e4ad" opacity=".25" stroke-dasharray="4 10" />
            <path d="M145 505c202 109 345 109 525-90" stroke="#a2e4ad" opacity=".26" stroke-dasharray="4 9" />
            <circle class="orb-point" cx="171" cy="245" r="4" />
            <circle class="orb-point" cx="647" cy="280" r="3" />
            <circle class="orb-point" cx="578" cy="614" r="4" />
            <circle class="orb-point" cx="370" cy="100" r="3" />
          </g>
          <g class="scan">
            <path d="M140 455 Q395 355 668 475" stroke="#55f68a" stroke-width="1.6" opacity=".42" />
            <circle cx="506" cy="398" r="5" fill="#d7ffb9" filter="url(#tos-glow)" />
          </g>
          <g opacity=".55" stroke="#55f68a" stroke-width=".7">
            <path d="M385 382h30M400 367v30" />
            <circle cx="400" cy="382" r="17" />
          </g>
        </svg>
      </div>
      <div class="hero-glass" aria-hidden="true">
        <div class="glass-top">
          <span>GATEWAY / HEALTH</span>
          <b :class="{ off: !online }">● {{ online === undefined ? "CHECKING" : online ? "ONLINE" : "UNREACHABLE" }}</b>
        </div>
        <svg class="glass-chart" viewBox="0 0 188 46">
          <path d="M0 40H188M0 23H188M0 6H188" stroke="#7ab992" opacity=".12" />
          <path
            d="M0 35L18 28 32 31 43 20 57 22 71 13 82 24 96 18 108 21 120 9 138 16 150 13 167 7 186 15"
            fill="none"
            stroke="#55f68a"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <div class="glass-bottom"><span>受管网关</span><b>{{ online ? "在线" : online === false ? "离线" : "—" }}</b></div>
      </div>
      <div class="hero-foot">
        <span>SAORSA / ONE PLATFORM. EVERY SUPPORTED CODING AGENT.</span>
        <span class="alive">{{ organization || "ENTERPRISE CONSOLE" }}</span>
      </div>
    </section>

    <section class="form-side">
      <div class="formtop"><span />SECURE ACCESS</div>
      <div class="login-card" :style="{ width: `min(100%, ${width}px)` }">
        <div class="sign-mini">{{ eyebrow }}</div>
        <h2>{{ title }}<span class="dot">.</span></h2>
        <p v-if="intro" class="intro">{{ intro }}</p>
        <slot />
      </div>
      <div class="form-foot">
        <span>© {{ new Date().getFullYear() }} Saorsa</span>
        <span>仅统计经企业网关的受管调用</span>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
import Icon from "./Icon.vue"
import Logo from "./Logo.vue"

withDefaults(defineProps<{ eyebrow: string; title: string; intro?: string; width?: number }>(), { width: 412 })
const online = ref<boolean>()
const organization = ref("")

onMounted(async () => {
  online.value = await fetch("/healthz").then((response) => response.ok).catch(() => false)
  const status = await fetch("/api/auth/status").then((response) => response.json()).catch(() => undefined)
  organization.value = status?.organization ?? ""
})
</script>

<style scoped>
/* The auth screens always use the dark brand treatment, regardless of the console theme. */
.login-shell {
  --text: #f2f5f3;
  --mint: #55f68a;
  --red: #ef6464;
  min-height: 100svh;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(420px, 0.85fr);
  background: #080b0a;
  color: var(--text);
  color-scheme: dark;
}
.dot { color: var(--mint); }
.hero {
  isolation: isolate;
  overflow: hidden;
  position: relative;
  min-height: 760px;
  padding: 42px clamp(40px, 5.3vw, 96px) 33px;
  background: radial-gradient(ellipse 80% 75% at 65% 58%, #182523 0%, #121613 37%, #0c0f0d 84%);
  display: flex;
  flex-direction: column;
  border-right: 1px solid #2d3830;
}
.hero::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.22;
  background-image: linear-gradient(#36433944 1px, transparent 1px), linear-gradient(90deg, #36433944 1px, transparent 1px);
  background-size: 57px 57px;
  mask-image: linear-gradient(90deg, transparent, #000 25%, #000 85%, transparent);
}
.hero::after {
  content: "";
  position: absolute;
  z-index: -1;
  width: 730px;
  height: 730px;
  border: 1px solid #91d89f19;
  border-radius: 50%;
  right: -370px;
  bottom: -330px;
  box-shadow: 0 0 0 80px #55f68a04, 0 0 0 160px #55f68a03;
}
.logo { display: flex; align-items: center; gap: 12px; position: relative; z-index: 4; color: var(--text); width: max-content; text-decoration: none !important; }
.logo-word { font-weight: 780; font-size: 26px; letter-spacing: -0.075em; line-height: 1; }
.logo-word > span { color: var(--mint); }
.logo-word small { display: block; margin-top: 8px; font-size: 8px; color: #90a095; letter-spacing: 0.26em; font-weight: 600; }
.hero-body { margin-top: clamp(78px, 11vh, 145px); position: relative; z-index: 4; max-width: 640px; }
.mini-label { display: flex; gap: 10px; align-items: center; font-size: 10px; color: var(--mint); font-weight: 740; letter-spacing: 0.2em; }
.mini-label::before { content: ""; width: 21px; height: 1px; background: var(--mint); }
h1 { font-size: clamp(53px, 5.4vw, 89px); line-height: 1.14; font-weight: 650; letter-spacing: -0.075em; margin: 25px 0 23px; white-space: nowrap; }
h1 em { font-style: normal; color: var(--mint); text-shadow: 0 0 42px #55f68a2a; }
.subtitle { font-size: 14px; line-height: 2.15; color: #a0b1a4; max-width: 420px; margin: 0; }
.feature-tags { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 26px; }
.feature-tags span {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  border: 1px solid #52614e66;
  background: #151916cc;
  color: #a9b7ab;
  font-size: 10px;
  padding: 7px 11px;
  border-radius: 6px;
}
.feature-tags :deep(svg) { color: var(--mint); }
.hero-foot { margin-top: auto; position: relative; z-index: 3; display: flex; gap: 16px; align-items: center; justify-content: space-between; color: #79917e; font-size: 10px; letter-spacing: 0.06em; }
.alive { display: inline-flex; align-items: center; gap: 8px; color: #a7c4a9; }
.alive::before { content: ""; height: 6px; width: 6px; border-radius: 50%; background: var(--mint); box-shadow: 0 0 0 5px #55f68a16; animation: live 2.7s infinite; }
.orbit-wrap { position: absolute; z-index: 1; bottom: 2%; right: -6%; width: min(800px, 86%); aspect-ratio: 1; pointer-events: none; opacity: 0.94; filter: drop-shadow(0 0 46px #8ce9a414); }
.orbit { width: 100%; height: 100%; overflow: visible; }
.orb-ring { fill: none; stroke: #aeefbc; stroke-width: 0.7; opacity: 0.23; }
.orb-ring.bright { opacity: 0.54; stroke-width: 1.3; }
.orb-inner { fill: none; stroke: url(#tos-ring); stroke-width: 1.1; }
.orb-point { fill: #d8ffc7; filter: url(#tos-glow); }
.orbit-core { transform-origin: 50% 50%; animation: drift 36s linear infinite; }
.scan { animation: scan 4s ease-in-out infinite; transform-origin: 50% 50%; }
.hero-glass {
  z-index: 3;
  position: absolute;
  right: 7%;
  bottom: 20%;
  width: 218px;
  padding: 14px 16px;
  background: linear-gradient(145deg, #172520dc, #111512cc);
  border: 1px solid #71967b4d;
  backdrop-filter: blur(18px);
  border-radius: 11px;
  box-shadow: 0 15px 75px #0008;
}
.glass-top { display: flex; align-items: center; justify-content: space-between; color: #98aa9e; font-size: 10px; letter-spacing: 0.08em; }
.glass-top b { color: var(--mint); font-weight: 650; }
.glass-top b.off { color: var(--red); }
.glass-chart { height: 46px; width: 100%; margin-top: 14px; }
.glass-bottom { display: flex; justify-content: space-between; align-items: baseline; color: #8fa09a; font-size: 10px; margin-top: 8px; }
.glass-bottom b { color: #e6f5ea; font-size: 16px; font-weight: 640; letter-spacing: -0.04em; }
.form-side {
  padding: 34px clamp(34px, 5vw, 100px);
  background: radial-gradient(ellipse at 90% 5%, #1b201c38, transparent 45%), #0f1210;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  position: relative;
}
.formtop { position: absolute; top: 42px; right: clamp(34px, 5vw, 100px); color: #849b89; font-size: 10px; letter-spacing: 0.13em; display: flex; gap: 10px; align-items: center; }
.formtop span { width: 6px; height: 6px; background: var(--mint); border-radius: 50%; }
.login-card { margin: auto 0; padding: 60px 0; }
.sign-mini { display: inline-flex; align-items: center; gap: 9px; font-size: 11px; letter-spacing: 0.16em; color: #94a899; font-weight: 700; }
.sign-mini::before { content: ""; height: 24px; width: 3px; border-radius: 5px; background: var(--mint); }
h2 { font-size: 39px; font-weight: 660; letter-spacing: -0.065em; line-height: 1.25; margin: 19px 0 12px; }
.intro { color: #92a696; font-size: 13px; line-height: 1.9; margin: 0 0 34px; white-space: pre-line; }
.form-foot { position: absolute; bottom: 35px; left: clamp(34px, 5vw, 100px); right: clamp(34px, 5vw, 100px); display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 10px; color: #6b8370; flex-wrap: wrap; }

/* Shared auth form controls (used through the slot). */
.login-card :deep(.fieldlabel) { display: flex; justify-content: space-between; margin: 19px 0 9px; font-weight: 600; font-size: 12px; color: #cbd5cd; }
.login-card :deep(.fieldrow) {
  height: 51px;
  border: 1px solid #38443b;
  background: #1a1f1b;
  display: flex;
  gap: 10px;
  align-items: center;
  border-radius: 10px;
  padding: 0 15px;
  transition: border 0.18s, box-shadow 0.18s;
}
.login-card :deep(.fieldrow:focus-within) { border-color: #55f68aa0; box-shadow: 0 0 0 4px #55f68a0d; }
.login-card :deep(.fieldrow.invalid) { border-color: var(--red); }
.login-card :deep(.fieldrow svg) { flex: 0 0 17px; color: #839988; }
.login-card :deep(.fieldrow input) { width: 100%; border: 0; outline: 0; background: transparent; color: #f0f5fa; font-size: 14px; min-width: 0; font-family: inherit; }
.login-card :deep(.fieldrow input::placeholder) { color: #5e7363; }
.login-card :deep(.ghost) { border: 0; background: none; color: #8a9f8f; display: grid; place-items: center; padding: 5px; cursor: pointer; }
.login-card :deep(.ghost:hover), .login-card :deep(.ghost[aria-pressed="true"]) { color: var(--mint); }
.login-card :deep(.errmsg) { font-size: 11px; color: #f28a8a; min-height: 21px; margin-top: 10px; line-height: 1.5; }
.login-card :deep(.signin) {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 0;
  border-radius: 10px;
  color: #111a12;
  background: var(--mint);
  font-weight: 750;
  font-size: 13px;
  height: 53px;
  margin-top: 15px;
  cursor: pointer;
  transition: transform 0.15s, background 0.15s, box-shadow 0.15s;
  box-shadow: 0 12px 36px #55f68a12;
  font-family: inherit;
}
.login-card :deep(.signin svg) { transition: transform 0.2s; }
.login-card :deep(.signin:hover:not(:disabled)) { background: #7cf9a4; box-shadow: 0 12px 48px #55f68a26; transform: translateY(-1px); }
.login-card :deep(.signin:hover:not(:disabled) svg) { transform: translateX(4px); }
.login-card :deep(.signin:disabled) { opacity: 0.55; cursor: not-allowed; }
.login-card :deep(.secondary) {
  width: 100%;
  height: 49px;
  border-radius: 10px;
  border: 1px solid #3c4a3f;
  background: #1c221d;
  color: #d6ddd7;
  font-size: 12px;
  font-weight: 650;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  margin-top: 12px;
  font-family: inherit;
}
.login-card :deep(.secondary:hover) { border-color: #8aa985; color: #eafaef; background: #1a2926; }
.login-card :deep(.hint) { display: flex; align-items: flex-start; gap: 10px; color: #768e7b; font-size: 11px; line-height: 1.8; margin-top: 24px; }
.login-card :deep(.hint svg) { flex: 0 0 16px; color: #829b8c; margin-top: 3px; }
.login-card :deep(.hint strong) { font-weight: 600; color: #a4b5a8; }

@keyframes live { 50% { opacity: 0.45; box-shadow: 0 0 0 8px #55f68a07; } }
@keyframes drift { to { transform: rotate(360deg); } }
@keyframes scan { 50% { opacity: 0.4; transform: translateY(-8px); } }
@media (max-width: 1120px) {
  .hero { padding: 35px 42px 30px; }
  .login-shell { grid-template-columns: minmax(0, 1fr) minmax(390px, 0.95fr); }
  h1 { font-size: clamp(47px, 5.7vw, 73px); }
  .orbit-wrap { right: -30%; }
  .hero-glass { right: 5%; bottom: 17%; }
  .form-side { padding: 50px 36px; }
  .form-foot { left: 36px; right: 36px; }
  .formtop { right: 36px; }
}
@media (max-width: 850px) {
  .login-shell { grid-template-columns: 1fr; }
  .hero { min-height: 120px; padding: 27px 30px; border-right: 0; border-bottom: 1px solid #2d3830; }
  .hero-body, .hero-foot, .orbit-wrap, .hero-glass { display: none; }
  .form-side { padding: 60px 30px 90px; min-height: calc(100svh - 120px); }
  .formtop { top: 20px; right: 30px; }
  .form-foot { bottom: 24px; left: 30px; right: 30px; }
}
@media (max-width: 520px) {
  .hero { min-height: 94px; padding: 24px 22px; }
  .logo-word { font-size: 23px; }
  .form-side { min-height: calc(100svh - 94px); padding: 60px 22px 92px; }
  h2 { font-size: 30px; }
  .formtop { top: 24px; right: 22px; }
  .form-foot { left: 22px; right: 22px; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
