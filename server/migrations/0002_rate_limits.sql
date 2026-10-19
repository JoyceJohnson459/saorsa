-- Per-scope rate limits enforced atomically in Redis. NULL means "use the organization default"
-- for projects, and "unlimited" for models and providers (which protect upstream account limits).

alter table projects
  add column requests_per_minute integer check (requests_per_minute is null or requests_per_minute > 0),
  add column tokens_per_minute integer check (tokens_per_minute is null or tokens_per_minute > 0);

alter table models
  add column concurrency_limit integer check (concurrency_limit is null or concurrency_limit > 0),
  add column requests_per_minute integer check (requests_per_minute is null or requests_per_minute > 0),
  add column tokens_per_minute integer check (tokens_per_minute is null or tokens_per_minute > 0);

alter table providers
  add column concurrency_limit integer check (concurrency_limit is null or concurrency_limit > 0),
  add column requests_per_minute integer check (requests_per_minute is null or requests_per_minute > 0);

-- Audit classifier now targets a TeamOS-managed model instead of an arbitrary admin-entered URL.
update policy_rules
  set config = (config - 'endpoint' - 'model') || jsonb_build_object('model_alias', null)
  where rule_type = 'project_relevance';
