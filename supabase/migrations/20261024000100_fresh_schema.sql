-- FRESH DATABASE ONLY. Never apply this bootstrap over existing production tables.
-- مخطط أولي للمناقشة فقط؛ لا تشغله قبل إعداد سياسات الوصول RLS ومراجعتها.
create extension if not exists pgcrypto;

create type public.app_role as enum ('admin','rep');
create type public.goods_status as enum ('available','reserved','sold','archived');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role public.app_role not null default 'rep',
  rep_code text unique,
  created_at timestamptz not null default now()
);

create table public.goods (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  area text,
  asking_price bigint not null check (asking_price >= 0),
  agreed_commission bigint not null default 0 check (agreed_commission >= 0),
  owner_name text,
  owner_phone text,
  status public.goods_status not null default 'available',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  goods_id uuid not null references public.goods(id),
  rep_id uuid not null references public.profiles(id),
  final_price bigint not null check (final_price >= 0),
  total_commission bigint not null check (total_commission >= 0),
  manager_share bigint not null check (manager_share >= 0),
  rep_share bigint not null check (rep_share >= 0),
  verified_by uuid references public.profiles(id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (manager_share + rep_share = total_commission)
);

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  goods_id uuid not null references public.goods(id),
  rep_id uuid references public.profiles(id),
  buyer_name text,
  buyer_phone text,
  status text not null default 'new',
  notes text,
  created_at timestamptz not null default now()
);

-- تحذير: لا تفعّل الجداول للعامة قبل تفعيل RLS وإضافة سياسات تفصل صلاحيات المدير والمندوب.

-- Fresh-database assumptions inferred from app.js (not a production introspection).
ALTER TABLE public.profiles
 ADD COLUMN status text NOT NULL DEFAULT 'pending'
   CHECK (status IN ('pending','approved','restricted','banned','removed')),
 ADD COLUMN permissions jsonb NOT NULL DEFAULT '{"can_add_inquiry":true}'::jsonb;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;
