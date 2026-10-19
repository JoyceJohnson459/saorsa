-- Exclusive key assignment. A member holds at most one provider key (user_id unique) and a key serves at most
-- one member (credential_id primary key), so n active keys let exactly n members work at the same time.
-- Rows exist only while held: release, idle expiry, logout and key revocation delete them.
create table credential_leases (
  credential_id uuid primary key references provider_credentials (id),
  provider_id uuid not null references providers (id),
  user_id uuid not null unique references users (id),
  claimed_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index credential_leases_provider_idx on credential_leases (provider_id);
