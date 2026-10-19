-- Saorsa tool center. Tool profiles live in catalog/tools.ts (reviewed code: install commands and config
-- templates never come from the database); these tables hold only what changes at runtime.

-- Which of the 12 tools a project group may use. A member may use a tool when the billing project of the
-- session allows it. Existing projects keep OpenCode, the only tool they could use before.
create table project_tools (
  project_id uuid not null references projects (id),
  tool_id text not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, tool_id)
);
insert into project_tools (project_id, tool_id) select id, 'opencode' from projects;

-- Sessions are bound to the tool they serve. Launcher sessions represent one signed-in device; tool tokens
-- the Launcher hands to a child process reference it and end with it. Existing client sessions are OpenCode.
alter table user_sessions drop constraint user_sessions_kind_check;
alter table user_sessions add constraint user_sessions_kind_check check (kind in ('web', 'client', 'launcher'));
alter table user_sessions drop constraint user_sessions_check;
alter table user_sessions add constraint user_sessions_project_check check (kind <> 'client' or project_id is not null);
alter table user_sessions
  add column tool_id text,
  add column parent_session_id uuid references user_sessions (id),
  add column device_id text;
update user_sessions set tool_id = 'opencode' where kind = 'client';
alter table user_sessions add constraint user_sessions_tool_check check (kind <> 'client' or tool_id is not null);
create index user_sessions_parent_idx on user_sessions (parent_session_id) where revoked_at is null;

alter table gateway_requests add column tool_id text, add column tool_version text;
update gateway_requests set tool_id = 'opencode';
create index gateway_requests_tool_time_idx on gateway_requests (tool_id, started_at desc);

-- Model capabilities beyond tools/reasoning, and an optional allow-list of tools per model (null = every tool
-- the project group allows).
alter table models
  add column supports_streaming boolean not null default true,
  add column supports_vision boolean not null default false,
  add column supports_structured_output boolean not null default false,
  add column allowed_tools text[];

-- What a member's Launcher last reported for one tool on one device. Reported by the Launcher, so it shows
-- what was detected on that machine, not a server-side guarantee.
create table managed_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  device_id text not null,
  device_label text,
  os text not null,
  arch text not null,
  tool_id text not null,
  installed boolean not null,
  version text,
  configured boolean not null default false,
  last_error text,
  launcher_version text,
  reported_at timestamptz not null default now(),
  unique (user_id, device_id, tool_id)
);

-- Actions a member approved in the Launcher. Paths and command output are not stored.
create table launcher_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  device_id text not null,
  tool_id text,
  action text not null check (action in ('install', 'update', 'uninstall', 'configure', 'restore', 'launch', 'doctor')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'cancelled')),
  version text,
  detail text,
  created_at timestamptz not null default now()
);
create index launcher_events_user_time_idx on launcher_events (user_id, created_at desc);

-- Protocols. A provider's primary protocol plus any others the same upstream serves at the same base URL with
-- the same keys (OpenAI and Volcengine Ark serve both Chat Completions and Responses).
alter table providers drop constraint providers_protocol_check;
alter table providers add constraint providers_protocol_check
  check (protocol in ('openai-chat', 'anthropic-messages', 'openai-responses', 'gemini'));
alter table providers add column extra_protocols text[] not null default '{}'
  check (extra_protocols <@ array['openai-chat', 'anthropic-messages', 'openai-responses', 'gemini']);
