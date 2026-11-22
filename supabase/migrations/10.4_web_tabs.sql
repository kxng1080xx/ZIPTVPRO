-- 10.4: websites added as tabs from /connect, per device: [{ id, name, url, nav }]
alter table devices add column if not exists web_tabs jsonb not null default '[]'::jsonb;
