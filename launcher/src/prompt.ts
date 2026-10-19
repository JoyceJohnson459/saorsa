import { createInterface } from "node:readline/promises"

/**
 * Every install, uninstall, configuration change and launch is shown first and needs an explicit "y". `--yes`
 * approves in advance (scripts); without a terminal and without `--yes` the action is refused.
 */
export async function consent(summary: string[], options: { yes: boolean }) {
  console.log(summary.map((line) => `  ${line}`).join("\n"))
  if (options.yes) return true
  if (!process.stdin.isTTY) {
    console.log("未在交互式终端中运行；如确认执行，请加 --yes。")
    return false
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await readline.question("继续吗？[y/N] ")
  readline.close()
  return /^y(es)?$/i.test(answer.trim())
}
