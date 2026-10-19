-- OpenCode TeamOS initial schema.
-- Money is stored as BIGINT micro-units of the row's currency (1 USD = 1_000_000 micros).
-- Prices are stored as micro-units per million tokens. No floating point money anywhere.
-- Deliberately absent: repositories, tasks, issues, pull requests, shared workspaces, agent jobs.

create table organization (
  id smallint primary key default 1 check (id = 1),
  name text not null,
  settings jsonb not null default '{}'::jsonb,
  initialized_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  email text,
  display_name text not null,
  password_hash text not null,
  account_type text not null check (account_type in ('ADMIN', 'MEMBER')),
  status text not null default 'active' check (status in ('active', 'disabled', 'deleted')),
  must_change_password boolean not null default false,
  failed_logins integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  notice_ack_version integer,
  notice_ack_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index users_username_uq on users (lower(username)) where deleted_at is null;
create unique index users_email_uq on users (lower(email)) where deleted_at is null and email is not null;

create table projects (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  description text not null default '',
  purpose text not null default '',
  tags text[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'archived')),
  concurrency_limit integer check (concurrency_limit is null or concurrency_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index projects_code_uq on projects (lower(code));

create table project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  user_id uuid not null references users (id),
  joined_at timestamptz not null default now(),
  unique (project_id, user_id)
);
create index project_members_user_idx on project_members (user_id);

-- Web sessions use an HttpOnly cookie; client sessions (OpenCode) are bound to exactly one billing project.
create table user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  kind text not null check (kind in ('web', 'client')),
  project_id uuid references projects (id),
  access_token_hash text not null unique,
  access_expires_at timestamptz not null,
  refresh_token_hash text unique,
  previous_refresh_token_hash text,
  expires_at timestamptz not null,
  device_label text,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  check (kind = 'web' or project_id is not null)
);
create index user_sessions_user_idx on user_sessions (user_id) where revoked_at is null;

create table device_authorizations (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'consumed', 'expired')),
  user_id uuid references users (id),
  project_id uuid references projects (id),
  client_label text,
  interval_seconds integer not null default 5,
  last_polled_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  consumed_at timestamptz
);

create table providers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  protocol text not null check (protocol in ('openai-chat', 'anthropic-messages')),
  base_url text not null,
  enabled boolean not null default true,
  priority integer not null default 100,
  health_status text not null default 'unknown' check (health_status in ('unknown', 'healthy', 'degraded', 'down')),
  health_message text,
  health_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index providers_name_uq on providers (lower(name));

-- The AES-256-GCM master key never lives in the database; key_version names which env key encrypted the row.
create table provider_credentials (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers (id),
  label text not null,
  ciphertext bytea not null,
  nonce bytea not null,
  key_version integer not null,
  last4 text not null,
  fingerprint text not null,
  status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
  priority integer not null default 100,
  failure_count integer not null default 0,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
create index provider_credentials_provider_idx on provider_credentials (provider_id) where status = 'active';

create table models (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references providers (id),
  upstream_model text not null,
  alias text not null,
  display_name text not null,
  context_limit integer,
  output_limit integer,
  default_max_output integer not null default 4096,
  supports_tools boolean not null default true,
  supports_reasoning boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, upstream_model)
);
create unique index models_alias_uq on models (lower(alias));

-- Price rows are append-only. A request freezes the version effective when it started.
create table pricing_versions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models (id),
  currency text not null default 'USD',
  input_per_mtok_micros bigint not null check (input_per_mtok_micros >= 0),
  output_per_mtok_micros bigint not null check (output_per_mtok_micros >= 0),
  cache_read_per_mtok_micros bigint not null default 0 check (cache_read_per_mtok_micros >= 0),
  cache_write_per_mtok_micros bigint not null default 0 check (cache_write_per_mtok_micros >= 0),
  reasoning_per_mtok_micros bigint check (reasoning_per_mtok_micros is null or reasoning_per_mtok_micros >= 0),
  source text not null default 'manual',
  effective_from timestamptz not null default now(),
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
create index pricing_versions_model_idx on pricing_versions (model_id, effective_from desc);

create table model_permissions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  model_id uuid not null references models (id),
  allowed boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (project_id, model_id)
);

-- Links gateway traffic to the OpenCode session that produced it. Attribution comes from the
-- authenticated client session's billing project, never from client-supplied headers.
create table project_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  project_id uuid not null references projects (id),
  client_session_id uuid not null references user_sessions (id),
  opencode_session_id text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  request_count integer not null default 0,
  unique (client_session_id, opencode_session_id)
);

create table gateway_requests (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  idempotency_key text,
  trace_id text not null,
  user_id uuid not null references users (id),
  project_id uuid not null references projects (id),
  client_session_id uuid not null references user_sessions (id),
  project_session_id uuid references project_sessions (id),
  opencode_session_id text,
  provider_id uuid references providers (id),
  model_id uuid references models (id),
  model_alias text not null,
  credential_id uuid references provider_credentials (id),
  protocol text not null,
  stream boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'streaming', 'succeeded', 'failed', 'rejected', 'cancelled')),
  http_status integer,
  error_code text,
  error_message text,
  upstream_request_id text,
  attempts integer not null default 0,
  billing_status text not null default 'pending' check (billing_status in ('pending', 'exact', 'estimated', 'unknown', 'none')),
  price_version_id uuid references pricing_versions (id),
  currency text not null default 'USD',
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  reserved_micros bigint not null default 0,
  risk_level text check (risk_level is null or risk_level in ('info', 'review', 'high')),
  client_ip text,
  user_agent text,
  started_at timestamptz not null default now(),
  first_byte_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  unique (user_id, idempotency_key)
);
create index gateway_requests_project_time_idx on gateway_requests (project_id, started_at desc);
create index gateway_requests_user_time_idx on gateway_requests (user_id, started_at desc);
create index gateway_requests_model_time_idx on gateway_requests (model_id, started_at desc);
create index gateway_requests_time_idx on gateway_requests (started_at desc);

-- Upstream retries are attempts of one visible request, never separately billed requests.
create table gateway_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references gateway_requests (id),
  attempt integer not null,
  credential_id uuid references provider_credentials (id),
  http_status integer,
  error text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (request_id, attempt)
);

create table usage_ledger (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references gateway_requests (id),
  entry_type text not null check (entry_type in ('charge', 'adjustment')),
  category text not null check (category in ('input', 'output', 'cache_read', 'cache_write', 'reasoning')),
  tokens bigint not null,
  unit_price_per_mtok_micros bigint not null,
  cost_micros bigint not null,
  currency text not null,
  estimated boolean not null,
  source text not null check (source in ('upstream', 'estimate', 'reconciliation')),
  price_version_id uuid references pricing_versions (id),
  user_id uuid not null references users (id),
  project_id uuid not null references projects (id),
  model_id uuid references models (id),
  occurred_at timestamptz not null,
  note text,
  created_by uuid references users (id),
  created_at timestamptz not null default now()
);
-- One charge per category per request makes retries and event replays idempotent.
create unique index usage_ledger_charge_uq on usage_ledger (request_id, category) where entry_type = 'charge';
create index usage_ledger_project_time_idx on usage_ledger (project_id, occurred_at);
create index usage_ledger_user_time_idx on usage_ledger (user_id, occurred_at);

create table budgets (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('org', 'project', 'user', 'user_project', 'model')),
  project_id uuid references projects (id),
  user_id uuid references users (id),
  model_id uuid references models (id),
  period text not null check (period in ('daily', 'monthly', 'total')),
  limit_micros bigint not null check (limit_micros >= 0),
  currency text not null default 'USD',
  warn_thresholds integer[] not null default '{80,95}',
  hard_limit boolean not null default true,
  per_request_max_micros bigint check (per_request_max_micros is null or per_request_max_micros > 0),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (scope_type = 'org' and project_id is null and user_id is null and model_id is null)
    or (scope_type = 'project' and project_id is not null and user_id is null and model_id is null)
    or (scope_type = 'user' and user_id is not null and project_id is null and model_id is null)
    or (scope_type = 'user_project' and user_id is not null and project_id is not null and model_id is null)
    or (scope_type = 'model' and model_id is not null and user_id is null and project_id is null)
  )
);
create unique index budgets_scope_uq on budgets (scope_type, project_id, user_id, model_id, period) nulls not distinct;

create table budget_counters (
  budget_id uuid not null references budgets (id),
  period_start timestamptz not null,
  spent_micros bigint not null default 0,
  reserved_micros bigint not null default 0,
  last_alert_threshold integer not null default 0,
  primary key (budget_id, period_start)
);

create table budget_reservations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references gateway_requests (id),
  budget_id uuid not null references budgets (id),
  period_start timestamptz not null,
  reserved_micros bigint not null,
  settled_micros bigint,
  status text not null default 'reserved' check (status in ('reserved', 'settled', 'released')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (request_id, budget_id)
);

create table budget_adjustments (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references budgets (id),
  admin_id uuid not null references users (id),
  kind text not null check (kind in ('set_limit', 'temporary_raise', 'reset_period')),
  old_limit_micros bigint,
  new_limit_micros bigint,
  delta_micros bigint,
  expires_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create table budget_alerts (
  id uuid primary key default gen_random_uuid(),
  budget_id uuid not null references budgets (id),
  period_start timestamptz not null,
  threshold integer not null,
  spent_micros bigint not null,
  limit_micros bigint not null,
  created_at timestamptz not null default now(),
  unique (budget_id, period_start, threshold)
);

create table policy_rules (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null unique,
  enabled boolean not null default true,
  action text not null default 'flag' check (action in ('flag', 'block')),
  config jsonb not null default '{}'::jsonb,
  updated_by uuid references users (id),
  updated_at timestamptz not null default now()
);

create table risk_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  project_id uuid references projects (id),
  request_id uuid references gateway_requests (id),
  category text not null,
  severity text not null check (severity in ('info', 'review', 'high')),
  confidence numeric(4, 3) not null,
  detector text not null,
  summary_redacted text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'confirmed', 'false_positive', 'resolved', 'appealed')),
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index risk_events_status_idx on risk_events (status, created_at desc);
create index risk_events_user_idx on risk_events (user_id, created_at desc);

create table risk_reviews (
  id uuid primary key default gen_random_uuid(),
  risk_event_id uuid not null references risk_events (id),
  reviewer_admin_id uuid not null references users (id),
  decision text not null check (decision in ('confirmed', 'false_positive', 'resolved', 'open')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create table risk_appeals (
  id uuid primary key default gen_random_uuid(),
  risk_event_id uuid not null references risk_events (id),
  user_id uuid not null references users (id),
  message text not null,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  category text not null,
  title text not null,
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);

create table audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references users (id),
  actor_type text not null check (actor_type in ('admin', 'member', 'system', 'anonymous')),
  action text not null,
  target_type text,
  target_id text,
  metadata_redacted jsonb not null default '{}'::jsonb,
  ip text,
  request_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_time_idx on audit_logs (created_at desc);

-- Audit rows are append-only for every database role the application uses.
create function audit_logs_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;
create trigger audit_logs_no_update before update or delete on audit_logs
  for each row execute function audit_logs_immutable();

insert into policy_rules (rule_type, enabled, action, config) values
  ('secret_leak', true, 'flag', '{}'::jsonb),
  ('project_relevance', false, 'flag', '{"mode":"keyword","min_overlap":0.02,"allow_audit_model":false}'::jsonb),
  ('request_burst', true, 'flag', '{"window_seconds":60,"max_requests":120}'::jsonb),
  ('cost_spike', true, 'flag', '{"window_minutes":60,"max_micros":20000000}'::jsonb),
  ('project_switching', true, 'flag', '{"window_hours":24,"max_switches":6}'::jsonb);
