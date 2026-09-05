-- PrimeBizValue — CRM + compliance migration (September 2026)
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Every statement is idempotent; re-running is safe.

-- ─────────────────────────────────────────────────────────────
-- 1. leads: turn the opt-in list into a real CRM record
-- ─────────────────────────────────────────────────────────────
create table if not exists leads (
  id          uuid primary key default gen_random_uuid(),
  first_name  text,
  last_name   text,
  email       text not null,
  phone       text,
  interest    text,
  state       text,
  consent     boolean not null default false,
  source      text,
  created_at  timestamptz not null default now()
);

alter table leads add column if not exists brand              text;
alter table leads add column if not exists units              text;
alter table leads add column if not exists company            text;

-- consent evidence (this is what makes a TCPA / CAN-SPAM record defensible)
alter table leads add column if not exists consent_text       text;         -- the exact language they agreed to
alter table leads add column if not exists consent_at         timestamptz;  -- when
alter table leads add column if not exists consent_ip         text;         -- from where
alter table leads add column if not exists consent_user_agent text;
alter table leads add column if not exists consent_page       text;         -- which page/form

-- channel-specific permissions, kept separate on purpose
alter table leads add column if not exists marketing_consent  boolean not null default false; -- email marketing
alter table leads add column if not exists sms_consent        boolean not null default false; -- SMS / calls (TCPA)

-- suppression
alter table leads add column if not exists unsubscribe_token  text;
alter table leads add column if not exists unsubscribed_at    timestamptz;
alter table leads add column if not exists bounced_at         timestamptz;

-- lifecycle
alter table leads add column if not exists updated_at         timestamptz not null default now();
alter table leads add column if not exists last_seen_at       timestamptz;
alter table leads add column if not exists tags               text[] not null default '{}';
alter table leads add column if not exists notes              text;

-- what the free tool told them (so follow-up can reference their own number)
alter table leads add column if not exists last_valuation_low   numeric;
alter table leads add column if not exists last_valuation_high  numeric;
alter table leads add column if not exists last_sde             numeric;
alter table leads add column if not exists last_revenue         numeric;
alter table leads add column if not exists last_valuation_at    timestamptz;

-- nurture sequence position
alter table leads add column if not exists nurture_step        int not null default 0;
alter table leads add column if not exists nurture_last_sent_at timestamptz;

-- one record per email address, case-insensitive
-- (if this fails on duplicates, run the dedupe block below first, then re-run)
create unique index if not exists leads_email_lower_uidx on leads (lower(email));

-- tokens must be unique when present
create unique index if not exists leads_unsub_token_uidx on leads (unsubscribe_token) where unsubscribe_token is not null;

-- backfill tokens for existing rows
update leads set unsubscribe_token = encode(gen_random_bytes(24), 'hex') where unsubscribe_token is null;

-- keep updated_at honest
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists leads_set_updated_at on leads;
create trigger leads_set_updated_at before update on leads for each row execute function set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- 2. email_events: an audit trail of every message we send
--    (CAN-SPAM defense is "show me what you sent, to whom, when,
--    and prove the unsubscribe link was in it")
-- ─────────────────────────────────────────────────────────────
create table if not exists email_events (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references leads(id) on delete set null,
  email       text not null,
  kind        text not null,            -- 'report' | 'valuation_summary' | 'nurture_1' | 'nurture_2' | 'nurture_3' | 'partner' ...
  subject     text,
  provider_id text,                     -- Resend message id
  status      text not null default 'sent',   -- 'sent' | 'failed' | 'suppressed'
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists email_events_lead_idx on email_events (lead_id, created_at desc);
create index if not exists email_events_kind_idx on email_events (kind, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 3. orders: link purchases to CRM records
-- ─────────────────────────────────────────────────────────────
alter table orders add column if not exists lead_id      uuid references leads(id) on delete set null;
alter table orders add column if not exists business_name text;
create index if not exists orders_email_idx on orders (lower(customer_email));

-- ─────────────────────────────────────────────────────────────
-- 4. Views the agents and the dashboard read
-- ─────────────────────────────────────────────────────────────

-- who can we legally email marketing to right now
create or replace view marketable_leads as
select l.*
from leads l
where l.marketing_consent = true
  and l.unsubscribed_at is null
  and l.bounced_at is null;

-- free-tool users who have not bought, by how long ago they ran a number
create or replace view nurture_queue as
select
  l.id, l.email, l.first_name, l.last_valuation_low, l.last_valuation_high, l.last_sde,
  l.last_valuation_at, l.nurture_step, l.nurture_last_sent_at, l.unsubscribe_token,
  extract(epoch from (now() - l.last_valuation_at)) / 86400 as days_since_valuation
from leads l
where l.marketing_consent = true
  and l.unsubscribed_at is null
  and l.bounced_at is null
  and l.last_valuation_at is not null
  and not exists (select 1 from orders o where lower(o.customer_email) = lower(l.email));

-- the numbers that matter, one row
create or replace view business_snapshot as
select
  (select count(*) from orders)                                                    as total_orders,
  (select coalesce(sum(amount_charged),0) from orders)                             as total_revenue,
  (select count(*) from orders where created_at > now() - interval '30 days')      as orders_30d,
  (select coalesce(sum(amount_charged),0) from orders where created_at > now() - interval '30 days') as revenue_30d,
  (select count(*) from leads)                                                     as total_leads,
  (select count(*) from leads where created_at > now() - interval '7 days')        as leads_7d,
  (select count(*) from leads where source = 'free-valuation')                     as free_valuations,
  (select count(*) from marketable_leads)                                          as marketable,
  (select count(*) from leads where unsubscribed_at is not null)                   as unsubscribed,
  (select count(*) from leads where interest ilike '%franchisor%')                 as franchisor_leads;

-- ─────────────────────────────────────────────────────────────
-- Franchisor Partner Program (self-serve, $2,500 setup + 30% code)
-- ─────────────────────────────────────────────────────────────
alter table partners add column if not exists contact_name       text;
alter table partners add column if not exists contact_email      text;
alter table partners add column if not exists contact_phone      text;
alter table partners add column if not exists units              text;
alter table partners add column if not exists website            text;
alter table partners add column if not exists logo_url           text;
alter table partners add column if not exists primary_color      text;
alter table partners add column if not exists secondary_color    text;
alter table partners add column if not exists transfer_process   text;
alter table partners add column if not exists notes              text;
alter table partners add column if not exists status             text default 'active';
alter table partners add column if not exists stripe_session_id  text;
alter table partners add column if not exists setup_fee_paid_at  timestamptz;
alter table partners add column if not exists setup_fee_amount   numeric;
alter table partners add column if not exists onboarded_at       timestamptz;
create unique index if not exists partners_session_uidx on partners (stripe_session_id) where stripe_session_id is not null;

-- business_snapshot gains partner counts (re-created below with the extra columns)
create or replace view business_snapshot as
select
  (select count(*) from orders)                                                    as total_orders,
  (select coalesce(sum(amount_charged),0) from orders)                             as total_revenue,
  (select count(*) from orders where created_at > now() - interval '30 days')      as orders_30d,
  (select coalesce(sum(amount_charged),0) from orders where created_at > now() - interval '30 days') as revenue_30d,
  (select count(*) from leads)                                                     as total_leads,
  (select count(*) from leads where created_at > now() - interval '7 days')        as leads_7d,
  (select count(*) from leads where source = 'free-valuation')                     as free_valuations,
  (select count(*) from marketable_leads)                                          as marketable,
  (select count(*) from leads where unsubscribed_at is not null)                   as unsubscribed,
  (select count(*) from leads where interest ilike '%franchisor%')                 as franchisor_leads,
  (select count(*) from orders where tier = 'summary')                             as summary_orders,
  (select count(*) from partners where setup_fee_paid_at is not null)              as paid_partners,
  (select count(*) from partners where setup_fee_paid_at is not null and onboarded_at is null) as partners_awaiting_onboarding;

-- ─────────────────────────────────────────────────────────────
-- Dedupe helper: only if the unique index above refused to build
-- ─────────────────────────────────────────────────────────────
-- delete from leads a using leads b
--  where lower(a.email) = lower(b.email) and a.created_at < b.created_at;
