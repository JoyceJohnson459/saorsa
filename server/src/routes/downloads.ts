import type { Hono } from "hono"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { ApiError, type AppEnv } from "../context.js"

/**
 * Saorsa Launcher builds for members, served from the directory the operator fills (SAORSA_DOWNLOADS_DIR) with
 * `saorsa-<platform>` binaries, their `.sha256` files, optional `.gz` copies and a VERSION file (`bun run package`
 * in launcher/ writes all of them). Public: members install the Launcher before signing in, and the binaries
 * contain no secrets. Only these exact file names are ever served.
 */
const BINARY = /^saorsa-(macos-arm64|macos-x64|windows-x64)(\.exe)?$/
const SHA256 = /^[0-9a-f]{64}$/

export function downloadRoutes(app: Hono<AppEnv>) {
  // One-line installs for members: `irm <origin>/install.ps1 | iex` (Windows, after enabling TLS 1.2 for 5.1) and `curl -fsSL <origin>/install.sh | sh`
  // (macOS). The scripts carry the build's checksum, download its smallest form with progress, refuse it unless
  // the SHA-256 matches, and put it on PATH.
  app.get("/install.ps1", async (c) => {
    const env = c.get("deps").env
    return script(windowsInstaller(env.TEAMOS_PUBLIC_URL, await installable(env.TEAMOS_DOWNLOADS_DIR, "saorsa-windows-x64.exe")))
  })
  app.get("/install.sh", async (c) => {
    const env = c.get("deps").env
    return script(
      macInstaller(env.TEAMOS_PUBLIC_URL, {
        arm64: await installable(env.TEAMOS_DOWNLOADS_DIR, "saorsa-macos-arm64"),
        x64: await installable(env.TEAMOS_DOWNLOADS_DIR, "saorsa-macos-x64"),
      }),
    )
  })

  app.get("/api/downloads", async (c) => {
    const dir = c.get("deps").env.TEAMOS_DOWNLOADS_DIR
    if (!dir) return c.json({ version: null, files: [] })
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => BINARY.test(name)).sort()
    const files = await Promise.all(
      names.map(async (name) => ({
        name,
        platform: BINARY.exec(name)![1],
        size: (await stat(path.join(dir, name))).size,
        sha256: (await checksum(dir, name)) ?? null,
        url: `/downloads/${name}`,
      })),
    )
    const version = (await Bun.file(path.join(dir, "VERSION")).text().catch(() => "")).trim() || null
    return c.json({ version, files })
  })

  app.get("/downloads/:name", async (c) => {
    const dir = c.get("deps").env.TEAMOS_DOWNLOADS_DIR
    const name = c.req.param("name")
    const [, binary, suffix] = /^(.+?)(\.sha256|\.gz)?$/.exec(name)!
    if (!dir || !BINARY.test(binary!)) throw new ApiError(404, "not_found", "No such download")
    const file = Bun.file(path.join(dir, name))
    if (!(await file.exists())) throw new ApiError(404, "not_found", "No such download")
    // A URL carrying the build's current checksum names fixed content, so Cloudflare may keep it at the edge and
    // spare the server's narrow uplink; a new build gets a new URL. Everything else is revalidated.
    const version = c.req.query("v")
    const pinned = suffix !== ".sha256" && version !== undefined && version === (await checksum(dir, binary!))
    return new Response(file, {
      headers: {
        "content-type": suffix === ".sha256" ? "text/plain; charset=utf-8" : suffix === ".gz" ? "application/gzip" : "application/octet-stream",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": pinned ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      },
    })
  })
}

/** The operator's checksum for a build, accepted only as 64 hex digits because installers embed it. */
async function checksum(dir: string, name: string) {
  const value = (await Bun.file(path.join(dir, `${name}.sha256`)).text().catch(() => "")).trim().split(/\s+/)[0]?.toLowerCase()
  return value && SHA256.test(value) ? value : undefined
}

/** What an installer needs for one build: its checksum and the pinned URL of its smallest form. */
async function installable(dir: string | undefined, name: string) {
  if (!dir || !(await Bun.file(path.join(dir, name)).exists())) return undefined
  const sha256 = await checksum(dir, name)
  if (!sha256) return undefined
  const gzip = await Bun.file(path.join(dir, `${name}.gz`)).exists()
  return { sha256, gzip, url: `/downloads/${name}${gzip ? ".gz" : ""}?v=${sha256}` }
}

type Installable = Awaited<ReturnType<typeof installable>>

const script = (body: string) =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } })

const powershellQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`

// Runs inside `iex`, so it must never call `exit` (that would close the member's PowerShell window).
// Invoke-WebRequest's own progress bar makes Windows PowerShell 5.1 download many times slower, so the build is
// streamed by hand with one progress line rewritten in place (at most every 250 ms).
const windowsInstaller = (origin: string, build: Installable) => {
  if (!build) return "& { Write-Host '服务器尚未提供 Windows 版 Saorsa Launcher，请联系管理员。' -ForegroundColor Red }\n"
  const download = build.gzip ? "$exe.download.gz" : "$exe.download"
  return [
    "& {",
    "  $ErrorActionPreference = 'Stop'",
    "  $ProgressPreference = 'SilentlyContinue'",
    "  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072",
    `  $S = ${powershellQuoted(origin)}`,
    `  $expected = '${build.sha256}'`,
    "  $dir = Join-Path $env:LOCALAPPDATA 'Saorsa\\bin'",
    "  $exe = Join-Path $dir 'saorsa.exe'",
    "  New-Item -ItemType Directory -Force $dir | Out-Null",
    "  function Save($Uri, $Path) {",
    "    $response = [Net.HttpWebRequest]::Create($Uri).GetResponse()",
    "    $in = $response.GetResponseStream()",
    "    $out = [IO.File]::Create($Path)",
    "    try {",
    "      $total = $response.ContentLength",
    "      $buffer = New-Object byte[] 262144",
    "      $done = 0",
    "      $watch = [Diagnostics.Stopwatch]::StartNew()",
    "      $shown = -1000",
    "      while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {",
    "        $out.Write($buffer, 0, $read)",
    "        $done += $read",
    "        if ($watch.ElapsedMilliseconds - $shown -ge 250 -or $done -eq $total) {",
    "          $shown = $watch.ElapsedMilliseconds",
    "          $speed = $done / 1MB / [Math]::Max($watch.Elapsed.TotalSeconds, 0.001)",
    "          $percent = if ($total -gt 0) { '{0,3}%' -f [int](100 * $done / $total) } else { '' }",
    "          $size = if ($total -gt 0) { '{0:N1} / {1:N1} MB' -f ($done / 1MB), ($total / 1MB) } else { '{0:N1} MB' -f ($done / 1MB) }",
    '          Write-Host -NoNewline ("`r  {0}  {1}  {2:N1} MB/s    " -f $percent, $size, $speed)',
    "        }",
    "      }",
    "      Write-Host ''",
    "    } finally {",
    "      $out.Dispose()",
    "      $in.Dispose()",
    "      $response.Dispose()",
    "    }",
    "  }",
    `  Write-Host '正在下载 Saorsa Launcher（Windows x64${build.gzip ? "，压缩传输" : ""}）…'`,
    "  try {",
    `    Save "$S${build.url}" "${download}"`,
    ...(build.gzip
      ? [
          '    $zip = [IO.File]::OpenRead("$exe.download.gz")',
          "    $unzip = New-Object IO.Compression.GZipStream($zip, [IO.Compression.CompressionMode]::Decompress)",
          '    $out = [IO.File]::Create("$exe.download")',
          "    try { $unzip.CopyTo($out) } finally { $out.Dispose(); $unzip.Dispose(); $zip.Dispose() }",
          '    Remove-Item "$exe.download.gz"',
        ]
      : []),
    "  } catch {",
    '    Remove-Item -ErrorAction SilentlyContinue "$exe.download", "$exe.download.gz"',
    '    Write-Host "下载失败：$($_.Exception.Message)。请稍后重试，或联系管理员。" -ForegroundColor Red',
    "    return",
    "  }",
    '  $actual = (Get-FileHash "$exe.download" -Algorithm SHA256).Hash',
    "  if ($actual -ne $expected) {",
    '    Remove-Item "$exe.download"',
    "    Write-Host 'SHA-256 校验失败，已删除下载的文件。请联系管理员。' -ForegroundColor Red",
    "    return",
    "  }",
    '  Move-Item -Force "$exe.download" $exe',
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  if (($userPath -split ';') -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $dir) | Where-Object { $_ }) -join ';'), 'User') }",
    '  if (($env:Path -split \';\') -notcontains $dir) { $env:Path = "$env:Path;$dir" }',
    '  Write-Host "已安装 Saorsa Launcher：$exe" -ForegroundColor Green',
    '  Write-Host "SHA-256 已校验：$expected"',
    '  Write-Host "下一步：saorsa login --server $S"',
    "}",
    "",
  ].join("\n")
}

// SAORSA_INSTALL_DIR overrides ~/.local/bin (used by tests and by members who keep tools elsewhere).
// Every variable is braced: under a UTF-8 locale macOS /bin/sh (bash 3.2) reads the first byte of a following
// full-width character such as "）" as part of the name, and `set -u` then aborts on the unknown variable.
const macInstaller = (origin: string, builds: { arm64: Installable; x64: Installable }) => {
  const arch = (match: string, build: Installable, label: string) =>
    build
      ? `  ${match}) P='${label}'; E='${build.sha256}'; U='${build.url}'; Z=${build.gzip ? 1 : 0} ;;`
      : `  ${match}) echo "服务器尚未提供 macOS（${label}）版 Saorsa Launcher，请联系管理员。" >&2; exit 1 ;;`
  return [
    "#!/bin/sh",
    "set -eu",
    `S='${origin.replaceAll("'", "'\\''")}'`,
    'case "$(uname -s)-$(uname -m)" in',
    arch("Darwin-arm64", builds.arm64, "Apple 芯片"),
    arch("Darwin-x86_64", builds.x64, "Intel"),
    '  *) echo "Saorsa Launcher 目前提供 macOS 与 Windows 版本（当前系统：$(uname -s) $(uname -m)）。" >&2; exit 1 ;;',
    "esac",
    'D="${SAORSA_INSTALL_DIR:-${HOME}/.local/bin}"',
    'T="${D}/.saorsa.download"',
    'mkdir -p "${D}"',
    'echo "正在下载 Saorsa Launcher（macOS ${P}）…"',
    'fail() { rm -f "${T}" "${T}.gz"; echo "下载失败，请稍后重试，或联系管理员。" >&2; exit 1; }',
    'if [ "${Z}" = 1 ]; then',
    '  curl -fL --progress-bar "${S}${U}" -o "${T}.gz" || fail',
    '  gunzip -c "${T}.gz" > "${T}" || fail',
    '  rm -f "${T}.gz"',
    "else",
    '  curl -fL --progress-bar "${S}${U}" -o "${T}" || fail',
    "fi",
    'A=$(shasum -a 256 "${T}" | awk \'{print $1}\')',
    'if [ "${A}" != "${E}" ]; then rm -f "${T}"; echo "SHA-256 校验失败，已删除下载的文件。请联系管理员。" >&2; exit 1; fi',
    'chmod +x "${T}"',
    'mv -f "${T}" "${D}/saorsa"',
    'echo "已安装 Saorsa Launcher：${D}/saorsa"',
    'echo "SHA-256 已校验：${A}"',
    'case ":${PATH}:" in',
    '  *":${D}:"*) echo "下一步：saorsa login --server ${S}" ;;',
    '  *) echo "export PATH=\\"${D}:\\${PATH}\\"" >> "${HOME}/.zshrc"; echo "已把 ${D} 加入 ~/.zshrc。请重新打开终端，然后运行：saorsa login --server ${S}" ;;',
    "esac",
    "",
  ].join("\n")
}
