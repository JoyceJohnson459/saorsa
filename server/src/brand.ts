/**
 * Identifiers Saorsa writes into member tool configs. Provider and MCP ids are re-sent on every OpenCode start,
 * so they follow the brand. TOKEN_ENV is stored by OpenCode at `opencode auth login` time; it keeps its
 * original name so existing logins keep working without logging in again. Internal ids (Redis keys, cookies,
 * `tos_` token prefixes, database and package names) keep their original TeamOS names.
 */
export const PROVIDER = "saorsa"
export const ANTHROPIC_PROVIDER = "saorsa-anthropic"
export const MCP_SERVER = "saorsa"
export const TOKEN_ENV = "NEXCODE_TOKEN"
