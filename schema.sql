-- ============================================================
-- CLEARVIEW DATABASE SCHEMA
-- Run this in your Supabase SQL editor (one time setup)
-- ============================================================

-- CLIENTS (your paying customers)
create table clients (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  name text not null,
  business_type text,
  phone text,
  email text,
  google_review_link text not null,
  twilio_number text,
  active boolean default true
);

-- CONTACTS (their patients/customers we text)
create table contacts (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  client_id uuid references clients(id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  status text default 'pending',
  -- statuses: pending, sms_sent, funnel_opened, clicked_good, clicked_bad, left_feedback, followup_sent
  sms_count integer default 0,
  last_sms_at timestamptz,
  funnel_opened_at timestamptz,
  clicked_good_at timestamptz
);

-- SMS LOG
create table sms_log (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  contact_id uuid references contacts(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade,
  message text,
  type text -- 'initial' or 'followup'
);

-- FEEDBACK (private, bad experience submissions)
create table feedback (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  client_id uuid references clients(id) on delete cascade,
  contact_id uuid,
  name text,
  feedback text not null,
  resolved boolean default false
);

-- REVIEWS (Google reviews + AI responses)
create table reviews (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  client_id uuid references clients(id) on delete cascade,
  reviewer_name text,
  rating integer,
  review_text text,
  ai_response text,
  responded boolean default false
);

-- ── INDEXES for performance ────────────────────────────────
create index on contacts(client_id);
create index on contacts(status);
create index on contacts(last_sms_at);
create index on sms_log(contact_id);
create index on reviews(client_id);
create index on feedback(client_id);

-- ── ROW LEVEL SECURITY (optional but recommended) ──────────
alter table clients enable row level security;
alter table contacts enable row level security;
alter table sms_log enable row level security;
alter table feedback enable row level security;
alter table reviews enable row level security;

-- Service role bypasses RLS (backend uses service key, so this is fine)
