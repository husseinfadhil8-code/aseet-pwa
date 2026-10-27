-- Additive Telegram-only; Test backup + hosted rollback required. No automatic sends/AI.
create table public.tg_market_intelligence_settings(singleton boolean primary key default true check(singleton),channel_enabled boolean not null default false,tips_enabled boolean not null default false,interval_hours int not null default 10 check(interval_hours between 1 and 168),last_channel_success timestamptz,last_topic uuid,assistant_enabled boolean not null default false,provider text not null default 'basic' check(provider in ('basic','cloudflare','openai')),style text not null default 'رد باللهجة العراقية بلطف وباختصار.',knowledge_version text,knowledge_approved boolean not null default false,daily_budget_micros bigint not null default 0 check(daily_budget_micros between 0 and 10000000),monthly_budget_micros bigint not null default 0 check(monthly_budget_micros between 0 and 100000000),free_neurons_day int not null default 0 check(free_neurons_day between 0 and 10000),version int not null default 1,check(length(style)<=1000));
insert into public.tg_market_intelligence_settings(singleton) values(true);
create table public.tg_market_guide_topics(id uuid primary key default gen_random_uuid(),slug text unique not null check(length(slug) between 2 and 60),title text not null check(length(title) between 3 and 120),body text not null check(length(body) between 10 and 900),tip text not null check(length(tip) between 10 and 400),route text not null check(route in ('home','wanted','radars','add','mine','inbox','account','notifications','support')),image_id uuid references public.tg_market_images(id),approved boolean not null default false,enabled boolean not null default true,version int not null default 1,created_at timestamptz not null default now());
create table public.tg_market_learning_preferences(user_id uuid primary key references public.tg_market_users(id) on delete cascade,enabled boolean not null default false,consent_at timestamptz,last_success timestamptz,last_attempt timestamptz,updated_at timestamptz not null default now(),check(not enabled or consent_at is not null));
create table public.tg_market_learning_seen(user_id uuid not null references public.tg_market_users(id) on delete cascade,topic_id uuid not null references public.tg_market_guide_topics(id),primary key(user_id,topic_id));
create table public.tg_market_guide_outbox(id uuid primary key default gen_random_uuid(),request_key uuid unique not null default gen_random_uuid(),kind text not null check(kind in ('channel','tip','support')),user_id uuid references public.tg_market_users(id),topic_id uuid references public.tg_market_guide_topics(id),topic_version int,manual boolean not null default false,body text not null check(length(body)<=900),route text not null,image_id uuid references public.tg_market_images(id),channel text,state text not null default 'pending' check(state in ('pending','sending','sent','failed','review','cancelled')),attempts int not null default 0,available_at timestamptz not null default now(),created_at timestamptz not null default now(),lease uuid,claimed_at timestamptz,sent_at timestamptz,message_id bigint,error_code text,check((kind='channel')=(user_id is null)));
create unique index tg_market_guide_channel_active on public.tg_market_guide_outbox(kind) where kind='channel' and state in ('pending','sending','review');
create unique index tg_market_guide_tip_active on public.tg_market_guide_outbox(user_id) where kind='tip' and state in ('pending','sending','review');
create index tg_market_guide_due on public.tg_market_guide_outbox(available_at) where state='pending';
create table public.tg_market_assistant_sessions(user_id uuid primary key references public.tg_market_users(id) on delete cascade,ai_consent_at timestamptz);
create table public.tg_market_assistant_jobs(id uuid primary key default gen_random_uuid(),update_id bigint unique not null,user_id uuid not null references public.tg_market_users(id),input text not null check(length(input)<=1500),state text not null default 'pending' check(state in ('pending','processing','ready','sending','sent','failed','review','cancelled')),output jsonb,lease uuid,claimed_at timestamptz,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '15 minutes',provider_reserved boolean not null default false,usage_day date,reserved_micros bigint not null default 0,reserved_neurons int not null default 0,input_tokens int,output_tokens int,error_code text,message_id bigint,support_confirmed boolean not null default false);
create index tg_market_assistant_pending on public.tg_market_assistant_jobs(created_at) where state in ('pending','ready');
create table public.tg_market_assistant_turns(id bigint generated always as identity primary key,user_id uuid not null references public.tg_market_users(id) on delete cascade,job_id uuid unique not null references public.tg_market_assistant_jobs(id) on delete cascade,question text not null,answer text not null,expires_at timestamptz not null default now()+interval '1 hour');
create table public.tg_market_assistant_usage(day date primary key,calls int not null default 0,reserved_micros bigint not null default 0,reserved_neurons bigint not null default 0,input_tokens bigint not null default 0,output_tokens bigint not null default 0);
create table public.tg_market_assistant_support(job_id uuid primary key references public.tg_market_assistant_jobs(id),user_id uuid not null references public.tg_market_users(id),summary text not null check(length(summary)<=600),created_at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['intelligence_settings','guide_topics','learning_preferences','learning_seen','guide_outbox','assistant_sessions','assistant_jobs','assistant_turns','assistant_usage','assistant_support'] loop execute format('alter table public.%I enable row level security','tg_market_'||t);execute format('revoke all on public.%I from public,anon,authenticated,service_role','tg_market_'||t);end loop;end$$;
revoke all on sequence public.tg_market_assistant_turns_id_seq from public,anon,authenticated,service_role;
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('radar','📡 تدور على غرض وما لكَيته؟','📡 تدور على غرض وما لكَيته؟
رادار وسيط يتابع إعلانات السوق المعتمدة حسب كلماتك والقسم والمحافظة والميزانية.
١. افتح حسابي ← راداري.
٢. حدد المواصفات واحفظ البحث.
٣. إذا تريد تنبيهات، وافق عليها بإعدادات البوت والرادار.
الفحص على دفعات، ووصول إشعار الهاتف يعتمد على إعدادات تلغرام والجهاز. الرادار المستقل يبقى خاص إلك.','هلا بيك 🌟 إذا تدور على غرض معين، رادار وسيط يتابعه حسب ميزانيتك ومنطقتك. تقدر تفعّل تنبيهاته بموافقتك من حسابي 📡','radars');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('wanted','🔎 تحتاج غرض معين؟','🔎 تحتاج غرض معين؟
انشر طلب شراء مجاني بقسم «مطلوب في وسيط».
اكتب الغرض، القسم، المحافظة والمنطقة، ميزانيتك والمواصفات؛ والصور اختيارية. بعد مراجعة الإدارة يظهر الطلب ويكدر أصحاب الإعلانات المعتمدة يقدمون عروضهم إلك.
تشوف العروض من حسابي ← طلباتي في مطلوب، وتراسل صاحب العرض داخل السوق. الطلب ينتهي بعد 30 يوم وتكدر تجدده.','تحتاج غرض وما لَكيته؟ 🔎 جرّب طلب شراء مجاني بقسم مطلوب؛ حدد ميزانيتك وشوف عروض أصحاب الأغراض بعد اعتماد الطلب.','wanted');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('post','📸 إعلانك المجاني بخطوات بسيطة','📸 عندك غرض وتريد تبيعه؟
نشر الإعلان مجاني داخل وسيط. اضغط «إعلان»، واكتب العنوان والسعر والمحافظة والوصف الواضح، وأضف حتى 5 صور حقيقية.
بيّن حالة الغرض وأي عطل، وراجع المعاينة قبل التأكيد. لا تضع بيانات حساسة أو رقم بطاقة بالوصف.
تعديل الإعلان يعيده للمراجعة، والنشر بالقناة موضوع مستقل عن ظهوره بالسوق.','صورة واضحة ووصف صادق يساعدان المشتري يفهم غرضك 📸 تكدر تضيف حتى 5 صور وتراجع إعلانك قبل نشره مجاناً.','add');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('search','🛍️ خلّي بحثك أدق','🛍️ شنو تدور؟
اكتب اسم الغرض بالبحث، واختر القسم وحدد أقل وأعلى سعر من الفلاتر. تفاصيل الإعلان تبين المحافظة والمنطقة حتى تتأكد من الموقع قبل المراسلة.
إذا تريد متابعة تلقائية بمحافظة وميزانية محددتين، احفظ رادار خاص إلك من حسابي. النتائج من إعلانات وسيط المتاحة؛ ما نضمن توفر كل غرض بكل وقت.','جرّب تضيق بحثك بالقسم والسعر 🛍️ وإذا ماكو نتيجة مناسبة، احفظ رادار بمحافظتك وميزانيتك حتى تتابع الجديد.','home');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('chat','💬 اسأل البائع داخل السوق','💬 لَكيت إعلان يناسبك؟
افتح تفاصيله واضغط «راسل البائع». المحادثة تبقى داخل سوق وسيط، وتشوف عنوان الإعلان والطرف المقابل.
اسأل عن الحالة والقياسات والموقع، ولا تشارك كلمات مرور أو رموز تحقق. فتح محادثة يحتاج جلسة تلغرام موثقة؛ التصفح العام ما يحتاج حساب إضافي.','قبل الاتفاق اسأل البائع عن الحالة والقياسات 💬 تقدر تراسله من تفاصيل الإعلان داخل وسيط، بدون نشر رقمك بالوصف.','home');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('edit','✏️ غرضك انباع؟ حدّث إعلانه','✏️ خلّي إعلانك محدّث
من «إعلاناتي» افتح غرضك حتى تعدّل التفاصيل أو تحدد أنه مباع أو تحذفه.
أي تعديل يرجع الإعلان للمراجعة، واعتماد الإعلان منفصل عن نتيجة نشره بالقناة. إذا انباع الغرض حدّث حالته حتى ما يستمر الناس يسألون عليه.','غرضك انباع؟ ✏️ حدّث حالته من إعلاناتي حتى تبقى معلومات السوق واضحة وما تجيك استفسارات غير ضرورية.','mine');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('notifications','🔔 التنبيه بقرارك','🔔 تريد تعرف من ينزل إعلان يناسبك؟
من حسابي ← إعدادات الإشعارات، وافق على رسائل البوت واختر فلاترك. وللرادار موافقة وإعدادات خاصة بيه.
تقدر توقف التنبيهات مؤقتاً أو تلغي الاشتراك. النصائح التعليمية الأسبوعية إلها موافقة مستقلة؛ تفعيل الرادار ما يشتركك بالنصائح.
تنبيه الهاتف يعتمد أيضاً على إذن المراسلة وإعدادات تلغرام والجهاز.','تنبيهاتك بقرارك 🔔 راجع فلاتر البوت والرادار، وتقدر توقفها مؤقتاً. النصائح الأسبوعية اختيار مستقل عن إشعارات أغراضك.','notifications');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('account','👤 حسابك مرتب بمكان واحد','👤 افتح حسابي وخلّي أمورك واضحة
تلقى طلبات الشراء، راداراتك، إعدادات الإشعارات والدعم. «إعلاناتي» للإعلانات اللي نشرتها، و«الرسائل» لمحادثاتك.
صلاحيات المندوب والإدارة منفصلة؛ المستخدم ما يشوف عمولات أو بيانات غيره. تسجيل الدخول داخل Mini App يعتمد جلسة تلغرام الموثقة، مو كلمة مرور إضافية.','تريد ترجع لطلباتك أو تضبط رادارك؟ 👤 افتح حسابي، وكل إعداد إله قسم واضح. لا ترسل رمز دخولك لأي شخص.','account');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('safety','🛡️ صفقة أوضح وأأمن','🛡️ قبل لا تتفق على غرض
شوف الصور والوصف واسأل عن العيوب. اتفق على مكان مناسب وافحص الغرض قبل تسليم المبلغ قدر الإمكان.
لا تشارك رمز تحقق أو بيانات بطاقة، وانتبه لطلبات العربون المستعجلة والروابط المجهولة. إذا شفت إعلان مشبوه استخدم «إبلاغ» أو تواصل ويا الدعم.
وسيط يسهل التواصل؛ وجود إعلان بالسوق مو ضمان لجودة الغرض أو هوية كل شخص.','خذ وقتك قبل الاتفاق 🛡️ افحص الغرض ولا تشارك رمز تحقق أو بيانات بطاقة. وإذا شفت شي مشبوه، بلّغ من الإعلان.','support');
insert into public.tg_market_guide_topics(slug,title,body,tip,route) values('services','🇮🇶 وسيط من الناس إلى الناس','🇮🇶 شنو يوفر وسيط إلك؟
سوق تتصفحه، إعلانات مجانية بصور، محادثات، مفضلة، طلبات شراء بقسم مطلوب ورادار خاص لمتابعة بحثك.
ويّاها نظام منفصل للمندوبين والأكاديمية والعمولات حسب الصلاحية. خدمات الترويج مرتبطة بالباقات المعتمدة وحالة فتح الدفع؛ إذا الشراء مقفل ما تقدر تشتري ترويج.
النتائج من سوقنا الحقيقي، بدون إحصائيات أو وعود وهمية.','بيع واشتري وتابع اللي تحتاجه من مكان واحد 🇮🇶 إعلانات مجانية، مطلوب، رادار ومحادثات؛ جرّب الميزة اللي تناسب حاجتك.','home');
create function public.tg_market_intelligence_action(p_actor bigint,p_operation text,p_data jsonb default '{}',p_admin boolean default false,p_name text default 'مستخدم') returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;cfg public.tg_market_intelligence_settings;t public.tg_market_guide_topics;oldcfg public.tg_market_settings;j public.tg_market_assistant_jobs;key uuid;root boolean;summary text;
begin
 perform public.tg_market_action(p_actor,'me','{}',p_admin,p_name);select * into u from public.tg_market_users where telegram_id=p_actor for update;
 if u.banned and p_operation not in ('tips_stop','forget') then raise exception 'account unavailable';end if;
 root:=p_admin and u.role='admin' and exists(select 1 from public.tg_market_root where user_id=u.id);
 if p_operation='bot_seen' then update public.tg_market_notify_preferences set blocked=false where user_id=u.id;return '{}';end if;
 if p_operation in ('preferences','tips_enable','tips_stop','ai_consent','forget') then
  if p_operation<>'preferences' and p_data->>'update' is not null then
   if exists(select 1 from public.tg_market_notify_updates where update_id>=(p_data->>'update')::bigint and actor=u.id) then return jsonb_build_object('replayed',true);end if;
   insert into public.tg_market_notify_updates(update_id,actor) values((p_data->>'update')::bigint,u.id) on conflict do nothing;if not found then return jsonb_build_object('replayed',true);end if;
  end if;
  if p_operation='tips_enable' then
   if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit marketing consent required';end if;
   insert into public.tg_market_learning_preferences(user_id,enabled,consent_at) values(u.id,true,now()) on conflict(user_id) do update set enabled=true,consent_at=case when public.tg_market_learning_preferences.enabled then public.tg_market_learning_preferences.consent_at else now() end,updated_at=now();
  elsif p_operation='tips_stop' then
   insert into public.tg_market_learning_preferences(user_id) values(u.id) on conflict(user_id) do update set enabled=false,updated_at=now();update public.tg_market_guide_outbox set state='cancelled' where kind='tip' and user_id=u.id and state='pending';
  elsif p_operation='ai_consent' then
   if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'explicit AI privacy consent required';end if;
   insert into public.tg_market_assistant_sessions(user_id,ai_consent_at) values(u.id,now()) on conflict(user_id) do update set ai_consent_at=now();
  elsif p_operation='forget' then
   delete from public.tg_market_assistant_turns where user_id=u.id;delete from public.tg_market_assistant_sessions where user_id=u.id;update public.tg_market_assistant_jobs set input='',output=null,state=case when state in ('pending','processing','ready') then 'cancelled' else state end where user_id=u.id;
  end if;
  select * into cfg from public.tg_market_intelligence_settings where singleton;
  return jsonb_build_object('tips_enabled',coalesce((select enabled from public.tg_market_learning_preferences where user_id=u.id),false),'ai_consent',exists(select 1 from public.tg_market_assistant_sessions where user_id=u.id and ai_consent_at is not null),'assistant_enabled',cfg.assistant_enabled,'provider',cfg.provider);
 end if;
 if p_operation='support_confirm' then
  select * into j from public.tg_market_assistant_jobs where id=(p_data->>'id')::uuid and user_id=u.id for update;
  if j.id is null or j.created_at<now()-interval '1 day' or p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'support confirmation required';end if;
  if not j.support_confirmed then
   summary:=left(coalesce(j.output->>'support_summary','طلب مساعدة من محادثة البوت'),500);
   perform public.tg_market_action(p_actor,'support',jsonb_build_object('body','طلب دعم بموافقة المستخدم: '||summary),p_admin,p_name);
   insert into public.tg_market_assistant_support(job_id,user_id,summary) values(j.id,u.id,summary);
   insert into public.tg_market_guide_outbox(request_key,kind,user_id,body,route) select j.id,'support',r.user_id,'وصل طلب دعم وافق صاحبه على مشاركته:'||chr(10)||summary,'guide_admin' from public.tg_market_root r;
   update public.tg_market_assistant_jobs set support_confirmed=true where id=j.id;
  end if;return jsonb_build_object('saved',true);
 end if;
 if not root then raise exception 'owner required';end if;
 select * into cfg from public.tg_market_intelligence_settings where singleton for update;
 if p_operation='kill' then update public.tg_market_intelligence_settings set channel_enabled=false,tips_enabled=false,assistant_enabled=false,version=version+1 where singleton;update public.tg_market_guide_outbox set state='cancelled' where kind in ('channel','tip') and state='pending';update public.tg_market_guide_outbox set state='review',error_code='stopped_inflight' where kind in ('channel','tip') and state='sending';return jsonb_build_object('stopped',true);end if;
 if p_operation='settings_save' then
  if p_data->'confirmed' is distinct from 'true'::jsonb or (p_data->>'version')::int is distinct from cfg.version then raise exception 'settings confirmation or version required';end if;
  update public.tg_market_intelligence_settings set channel_enabled=coalesce((p_data->>'channel_enabled')::boolean,channel_enabled),tips_enabled=coalesce((p_data->>'tips_enabled')::boolean,tips_enabled),interval_hours=coalesce((p_data->>'interval_hours')::int,interval_hours),assistant_enabled=coalesce((p_data->>'assistant_enabled')::boolean,assistant_enabled),provider=coalesce(p_data->>'provider',provider),style=coalesce(p_data->>'style',style),daily_budget_micros=coalesce((p_data->>'daily_budget_micros')::bigint,daily_budget_micros),monthly_budget_micros=coalesce((p_data->>'monthly_budget_micros')::bigint,monthly_budget_micros),free_neurons_day=coalesce((p_data->>'free_neurons_day')::int,free_neurons_day),version=version+1 where singleton returning * into cfg;
  if cfg.assistant_enabled and (not cfg.knowledge_approved or cfg.provider='basic' or (cfg.provider='openai' and (cfg.daily_budget_micros=0 or cfg.monthly_budget_micros=0)) or (cfg.provider='cloudflare' and cfg.free_neurons_day=0)) then raise exception 'approved knowledge provider and limits required';end if;
  return to_jsonb(cfg);
 end if;
 if p_operation='knowledge_approve' then
  if p_data->'confirmed' is distinct from 'true'::jsonb or length(p_data->>'version') not between 3 and 80 then raise exception 'confirmation required';end if;
  update public.tg_market_intelligence_settings set knowledge_version=p_data->>'version',knowledge_approved=true,version=version+1 where singleton;return jsonb_build_object('saved',true);
 end if;
 if p_operation='topic_save' then
  key:=coalesce((p_data->>'id')::uuid,gen_random_uuid());select * into t from public.tg_market_guide_topics where id=key for update;
  if t.id is not null and (p_data->>'version')::int is distinct from t.version then raise exception 'topic version conflict';end if;
  if (p_data->>'approved')::boolean and p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'content approval required';end if;
  if p_data->>'image_id' is not null and not exists(select 1 from public.tg_market_images where id=(p_data->>'image_id')::uuid and owner_id=u.id and ready) then raise exception 'invalid image';end if;
  insert into public.tg_market_guide_topics(id,slug,title,body,tip,route,image_id,approved,enabled) values(key,coalesce(t.slug,'custom-'||key),p_data->>'title',p_data->>'body',p_data->>'tip',p_data->>'route',(p_data->>'image_id')::uuid,coalesce((p_data->>'approved')::boolean,false),coalesce((p_data->>'enabled')::boolean,true)) on conflict(id) do update set title=excluded.title,body=excluded.body,tip=excluded.tip,route=excluded.route,image_id=excluded.image_id,approved=excluded.approved,enabled=excluded.enabled,version=public.tg_market_guide_topics.version+1 returning * into t;return to_jsonb(t);
 end if;
 if p_operation='topic_delete' then update public.tg_market_guide_topics set enabled=false,approved=false,version=version+1 where id=(p_data->>'id')::uuid;return '{}';end if;
 if p_operation='manual_publish' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'publication confirmation required';end if;
  if exists(select 1 from public.tg_market_guide_outbox where request_key=(p_data->>'key')::uuid) then return jsonb_build_object('queued',true);end if;
  select * into oldcfg from public.tg_market_settings where singleton;select * into t from public.tg_market_guide_topics where id=(p_data->>'id')::uuid and approved and enabled;
  if t.id is null or not oldcfg.channel_verified or oldcfg.channel is null or t.id=cfg.last_topic or cfg.last_channel_success>now()-interval '1 minute' then raise exception 'verified channel approved different topic required';end if;
  insert into public.tg_market_guide_outbox(request_key,kind,topic_id,topic_version,manual,body,route,image_id,channel) values((p_data->>'key')::uuid,'channel',t.id,t.version,true,t.body,t.route,t.image_id,oldcfg.channel);return jsonb_build_object('queued',true);
 end if;
 if p_operation='resolve' then
  if p_data->'confirmed' is distinct from 'true'::jsonb then raise exception 'review confirmation required';end if;
  select * into oldcfg from public.tg_market_settings where singleton;
  if p_data->'delivered'='true'::jsonb and coalesce((p_data->>'message_id')::bigint,0)<=0 then raise exception 'verified message id required';end if;
  update public.tg_market_guide_outbox set state=case when p_data->'delivered'='true'::jsonb then 'sent' else 'failed' end,message_id=(p_data->>'message_id')::bigint,sent_at=case when p_data->'delivered'='true'::jsonb then now() end,error_code='admin_verified' where id=(p_data->>'id')::uuid and state='review' returning topic_id into key;
  if found and p_data->'delivered'='true'::jsonb and exists(select 1 from public.tg_market_guide_outbox where id=(p_data->>'id')::uuid and kind='channel') then update public.tg_market_intelligence_settings set last_channel_success=now(),last_topic=key where singleton;end if;return '{}';
 end if;
 if p_operation='admin' then
  return jsonb_build_object('settings',to_jsonb(cfg)||jsonb_build_object('next_channel_at',cfg.last_channel_success+make_interval(hours=>cfg.interval_hours)),'topics',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_guide_topics order by created_at,id)q),'[]'),'recent',coalesce((select jsonb_agg(to_jsonb(q)) from(select id,kind,topic_id,state,attempts,created_at,sent_at,error_code,message_id from public.tg_market_guide_outbox order by created_at desc limit 40)q),'[]'),'metrics',jsonb_build_object('tips_subscribers',(select count(*) from public.tg_market_learning_preferences where enabled),'tips_opted_out',(select count(*) from public.tg_market_learning_preferences where not enabled),'sent',(select count(*) from public.tg_market_guide_outbox where state='sent'),'failed',(select count(*) from public.tg_market_guide_outbox where state in ('failed','review')),'assistant_messages',(select count(*) from public.tg_market_assistant_jobs),'support_requests',(select count(*) from public.tg_market_assistant_support),'tip_sent',(select count(*) from public.tg_market_guide_outbox where kind='tip' and state='sent'),'tip_failed',(select count(*) from public.tg_market_guide_outbox where kind='tip' and state in ('failed','review')),'assistant_errors',(select count(*) from public.tg_market_assistant_jobs where error_code is not null)),'usage',coalesce((select jsonb_agg(to_jsonb(q)) from(select * from public.tg_market_assistant_usage order by day desc limit 31)q),'[]'),'support',coalesce((select jsonb_agg(to_jsonb(q)) from(select ss.job_id,ss.summary,ss.created_at from public.tg_market_assistant_support ss order by ss.created_at desc limit 30)q),'[]'));
 end if;
 raise exception 'unknown intelligence operation';
end$$;
create function public.tg_market_guide_valid(p_job uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tg_market_guide_outbox j cross join public.tg_market_intelligence_settings cfg cross join public.tg_market_settings sc where j.id=p_job and j.state in ('pending','sending') and (j.user_id is null or not exists(select 1 from public.tg_market_notify_preferences where user_id=j.user_id and blocked)) and case when j.kind='support' then exists(select 1 from public.tg_market_users u join public.tg_market_root r on r.user_id=u.id where u.id=j.user_id and u.role='admin' and not u.banned) when j.kind='channel' then (j.manual or cfg.channel_enabled) and sc.channel_verified and sc.channel=j.channel and exists(select 1 from public.tg_market_guide_topics t where t.id=j.topic_id and t.enabled and t.approved and t.version=j.topic_version) else cfg.tips_enabled and exists(select 1 from public.tg_market_learning_preferences p join public.tg_market_users u on u.id=p.user_id and not u.banned where p.user_id=j.user_id and p.enabled and p.consent_at<=j.created_at and not exists(select 1 from public.tg_market_notify_preferences np where np.user_id=u.id and np.blocked)) and exists(select 1 from public.tg_market_guide_topics t where t.id=j.topic_id and t.enabled and t.approved and t.version=j.topic_version) end);
$$;
create function public.tg_market_guide_worker(p_operation text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg public.tg_market_intelligence_settings;sc public.tg_market_settings;t public.tg_market_guide_topics;j public.tg_market_guide_outbox;p public.tg_market_learning_preferences;ctl public.tg_market_notify_control;vlease uuid;chat bigint;img jsonb;delay int;
begin
 if p_operation='schedule' then
  select * into cfg from public.tg_market_intelligence_settings where singleton for update;select * into sc from public.tg_market_settings where singleton;
  update public.tg_market_guide_outbox set state='review',error_code='delivery_uncertain' where state='sending' and claimed_at<now()-interval '5 minutes';
  if cfg.channel_enabled and sc.channel_verified and sc.channel is not null and (cfg.last_channel_success is null or cfg.last_channel_success+make_interval(hours=>cfg.interval_hours)<=now()) and not exists(select 1 from public.tg_market_guide_outbox where kind='channel' and state in ('pending','sending','review')) then
   select * into t from public.tg_market_guide_topics where enabled and approved and id is distinct from cfg.last_topic order by coalesce((select max(sent_at) from public.tg_market_guide_outbox where topic_id=tg_market_guide_topics.id and kind='channel'),'-infinity'::timestamptz),created_at,id limit 1;
   if t.id is not null then insert into public.tg_market_guide_outbox(kind,topic_id,topic_version,body,route,image_id,channel) values('channel',t.id,t.version,t.body,t.route,t.image_id,sc.channel);end if;
  end if;
  if cfg.tips_enabled then
   for p in select pref.* from public.tg_market_learning_preferences pref join public.tg_market_users u on u.id=pref.user_id and not u.banned where pref.enabled and (pref.last_success is null or pref.last_success<=now()-interval '7 days') and (pref.last_attempt is null or pref.last_attempt<=now()-interval '7 days') and not exists(select 1 from public.tg_market_notify_preferences where user_id=pref.user_id and blocked) and not exists(select 1 from public.tg_market_guide_outbox where user_id=pref.user_id and kind='tip' and state in ('pending','sending','review')) order by pref.updated_at,pref.user_id for update of pref skip locked limit 10 loop
    select * into t from public.tg_market_guide_topics where enabled and approved and not exists(select 1 from public.tg_market_learning_seen where user_id=p.user_id and topic_id=tg_market_guide_topics.id) order by created_at,id limit 1;
    if t.id is not null then insert into public.tg_market_guide_outbox(kind,user_id,topic_id,topic_version,body,route) values('tip',p.user_id,t.id,t.version,t.tip,t.route);end if;
   end loop;
  end if;return '{}';
 end if;
 if p_operation='claim' then
  select * into ctl from public.tg_market_notify_control where singleton for update;
  if ctl.next_send_at>now() then return jsonb_build_object('wait_ms',ceil(extract(epoch from ctl.next_send_at-now())*1000));end if;
  select * into j from public.tg_market_guide_outbox where state='pending' and available_at<=now() order by case kind when 'support' then 0 when 'channel' then 1 else 2 end,created_at for update skip locked limit 1;
  if j.id is null then return '{}';end if;
  if j.attempts>=5 then if j.kind='channel' then update public.tg_market_intelligence_settings set channel_enabled=false where singleton;elsif j.kind='tip' then update public.tg_market_learning_preferences set enabled=false where user_id=j.user_id;end if;end if;
  if not public.tg_market_guide_valid(j.id) or j.attempts>=5 then update public.tg_market_guide_outbox set state='cancelled',error_code='ineligible' where id=j.id;return '{}';end if;
  vlease:=gen_random_uuid();update public.tg_market_guide_outbox set state='sending',attempts=attempts+1,lease=vlease,claimed_at=now() where id=j.id;
  update public.tg_market_notify_control set next_send_at=now()+interval '1.1 seconds' where singleton;
  if j.kind='tip' then insert into public.tg_market_learning_seen(user_id,topic_id) values(j.user_id,j.topic_id) on conflict do nothing;update public.tg_market_learning_preferences set last_attempt=now() where user_id=j.user_id;end if;
  select telegram_id into chat from public.tg_market_users where id=j.user_id;
  if j.image_id is not null then select jsonb_build_object('path',path,'mime',mime) into img from public.tg_market_images where id=j.image_id and ready;end if;
  return jsonb_build_object('id',j.id,'lease',vlease,'kind',j.kind,'chat',case when j.kind='channel' then to_jsonb(j.channel) else to_jsonb(chat) end,'body',j.body,'route',j.route,'image',img);
 end if;
 select * into j from public.tg_market_guide_outbox where id=(p_data->>'id')::uuid and lease=(p_data->>'lease')::uuid and state='sending' for update;
 if j.id is null then return jsonb_build_object('valid',false);end if;
 if p_operation='validate' then
  if not public.tg_market_guide_valid(j.id) then update public.tg_market_guide_outbox set state='cancelled',error_code='ineligible' where id=j.id;return jsonb_build_object('valid',false);end if;return jsonb_build_object('valid',true);
 end if;
 if p_operation='finish' then
  if p_data->>'outcome'='sent' and coalesce((p_data->>'message')::bigint,0)>0 then
   update public.tg_market_guide_outbox set state='sent',sent_at=now(),message_id=(p_data->>'message')::bigint where id=j.id;
   if j.kind='channel' then update public.tg_market_intelligence_settings set last_channel_success=now(),last_topic=j.topic_id where singleton;elsif j.kind='tip' then update public.tg_market_learning_preferences set last_success=now() where user_id=j.user_id;end if;
  elsif p_data->>'outcome' in ('rate_limited','retryable') then
   delay:=least(86400,greatest(1,coalesce((p_data->>'retry_after')::int,30)));update public.tg_market_guide_outbox set state='pending',available_at=now()+make_interval(secs=>delay),lease=null,error_code=p_data->>'outcome' where id=j.id;
   if p_data->>'outcome'='rate_limited' then update public.tg_market_notify_control set next_send_at=now()+make_interval(secs=>delay) where singleton;end if;
  else
   update public.tg_market_guide_outbox set state=case when p_data->>'outcome'='review' then 'review' else 'failed' end,error_code=left(p_data->>'outcome',40) where id=j.id;
   if j.kind='channel' and p_data->>'outcome' in ('failed','blocked') then update public.tg_market_intelligence_settings set channel_enabled=false where singleton;end if;
   if j.kind='tip' and p_data->>'outcome'='failed' then update public.tg_market_learning_preferences set enabled=false where user_id=j.user_id;end if;
   if p_data->>'outcome'='blocked' and j.user_id is not null then update public.tg_market_learning_preferences set enabled=false where user_id=j.user_id;insert into public.tg_market_notify_preferences(user_id,blocked,enabled) values(j.user_id,true,false) on conflict(user_id) do update set blocked=true,enabled=false;end if;
  end if;return '{}';
 end if;raise exception 'unknown guide operation';
end$$;
-- Narrow live public search: no owner IDs, contact data, unapproved/private/rep inventory.
create function public.tg_market_assist_search(p_data jsonb default '{}') returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(q)),'[]') from(select l.id,l.title,l.price,l.governorate,l.area,l.condition from public.tg_market_listings l join public.tg_market_users u on u.id=l.owner_id and not u.banned where l.status='active' and l.approved_at is not null and not exists(select 1 from public.tg_market_reports where listing_id=l.id and status='open') and (coalesce(p_data->>'category','')='' or l.category=p_data->>'category') and (coalesce(p_data->>'governorate','')='' or public.tg_market_radar_normalize(l.governorate)=public.tg_market_radar_normalize(p_data->>'governorate')) and l.price<=least(1000000000000,greatest(0,coalesce((p_data->>'max_price')::bigint,1000000000000))) and (p_data->'ids' is null or l.id in(select jsonb_array_elements_text(p_data->'ids')::uuid)) and (coalesce(p_data->>'query','')='' or not exists(select 1 from regexp_split_to_table(public.tg_market_radar_normalize(left(p_data->>'query',80)),' +') k where not k=any(regexp_split_to_array(public.tg_market_radar_normalize(l.title),' +')))) order by l.created_at desc,l.id limit 5)q;
$$;
create function public.tg_market_assistant_worker(p_operation text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.tg_market_assistant_jobs;u public.tg_market_users;cfg public.tg_market_intelligence_settings;vlease uuid;tokens_in int;tokens_out int;cost bigint;neurons int;d public.tg_market_assistant_usage;msg bigint;
begin
 if p_operation='enqueue' then
  if coalesce((p_data->>'message_date')::bigint,0)<extract(epoch from now())-900 or (p_data->>'message_date')::bigint>extract(epoch from now())+30 or coalesce((p_data->>'update')::bigint,-1)<0 then return '{}';end if;
  perform public.tg_market_action((p_data->>'actor')::bigint,'me','{}',coalesce((p_data->>'admin')::boolean,false),coalesce(p_data->>'name','مستخدم'));
  select * into u from public.tg_market_users where telegram_id=(p_data->>'actor')::bigint for update;if u.banned then return '{}';end if;
  update public.tg_market_notify_preferences set blocked=false where user_id=u.id and blocked;
  select * into j from public.tg_market_assistant_jobs where update_id=(p_data->>'update')::bigint;if j.id is not null then return jsonb_build_object('id',j.id,'duplicate',true);end if;
  if (select count(*) from public.tg_market_assistant_jobs where user_id=u.id and created_at>now()-interval '1 minute')>=5 or (select count(*) from public.tg_market_assistant_jobs where user_id=u.id and created_at>date_trunc('day',now()))>=40 then return jsonb_build_object('limited',true);end if;
  insert into public.tg_market_assistant_jobs(update_id,user_id,input) values((p_data->>'update')::bigint,u.id,left(p_data->>'text',1500)) returning * into j;return jsonb_build_object('id',j.id);
 end if;
 if p_operation='claim' then
  delete from public.tg_market_assistant_turns where expires_at<=now();
  update public.tg_market_assistant_jobs set state='failed',error_code='processing_uncertain' where state='processing' and claimed_at<now()-interval '3 minutes';
  update public.tg_market_assistant_jobs set state='review',error_code='delivery_uncertain' where state='sending' and claimed_at<now()-interval '5 minutes';
  update public.tg_market_assistant_jobs set state='cancelled' where state in ('pending','ready') and expires_at<=now();
  update public.tg_market_assistant_jobs set input='',output=null where created_at<now()-interval '1 hour' and (input<>'' or output is not null) and state not in ('processing','sending');
  delete from public.tg_market_assistant_jobs where id in(select a.id from public.tg_market_assistant_jobs a where a.created_at<now()-interval '7 days' and not exists(select 1 from public.tg_market_assistant_support where job_id=a.id) limit 50);
  select a.* into j from public.tg_market_assistant_jobs a join public.tg_market_users usr on usr.id=a.user_id and not usr.banned where a.state in ('pending','ready') and (p_data->>'id' is null or a.id=(p_data->>'id')::uuid) and not exists(select 1 from public.tg_market_assistant_jobs b where b.user_id=a.user_id and b.created_at<a.created_at and b.state in ('pending','processing','ready','sending')) order by a.created_at for update of a skip locked limit 1;
  if j.id is null then return '{}';end if;
  select * into u from public.tg_market_users where id=j.user_id;select * into cfg from public.tg_market_intelligence_settings where singleton;
  vlease:=gen_random_uuid();update public.tg_market_assistant_jobs set state=case when j.state='ready' then 'sending' else 'processing' end,lease=vlease,claimed_at=now() where id=j.id;
  return jsonb_build_object('id',j.id,'lease',vlease,'delivery',j.state='ready','output',j.output,'chat',u.telegram_id,'actor',u.telegram_id,'input',j.input,'config',to_jsonb(cfg),'ai_consent',exists(select 1 from public.tg_market_assistant_sessions where user_id=u.id and ai_consent_at is not null),'context',coalesce((select jsonb_agg(to_jsonb(q)) from(select question,answer from public.tg_market_assistant_turns where user_id=u.id and expires_at>now() order by id desc limit 3)q),'[]'));
 end if;
 select * into j from public.tg_market_assistant_jobs where id=(p_data->>'id')::uuid and lease=(p_data->>'lease')::uuid for update;
 if j.id is null then return jsonb_build_object('valid',false);end if;
 if p_operation='reserve' and j.state='processing' then
  select * into cfg from public.tg_market_intelligence_settings where singleton for update;
  if j.provider_reserved or not cfg.assistant_enabled or not cfg.knowledge_approved or cfg.knowledge_version is distinct from p_data->>'knowledge_version' or cfg.provider is distinct from p_data->>'provider' or p_data->'authorized' is distinct from 'true'::jsonb or not exists(select 1 from public.tg_market_assistant_sessions where user_id=j.user_id and ai_consent_at is not null) then return jsonb_build_object('allowed',false);end if;
  cost:=coalesce((p_data->>'reserve_micros')::bigint,0);neurons:=coalesce((p_data->>'reserve_neurons')::int,0);
  if cost not between 0 and 100000 or neurons not between 0 and 1000 or (cfg.provider='openai' and (cost=0 or neurons<>0)) or (cfg.provider='cloudflare' and (neurons=0 or cost<>0)) then raise exception 'invalid reservation';end if;
  insert into public.tg_market_assistant_usage(day) values(current_date) on conflict do nothing;select * into d from public.tg_market_assistant_usage where day=current_date for update;
  if cfg.provider='openai' and (d.reserved_micros+cost>cfg.daily_budget_micros or (select coalesce(sum(reserved_micros),0) from public.tg_market_assistant_usage where day>=date_trunc('month',now())::date)+cost>cfg.monthly_budget_micros) then return jsonb_build_object('allowed',false);end if;
  if cfg.provider='cloudflare' and d.reserved_neurons+neurons>cfg.free_neurons_day then return jsonb_build_object('allowed',false);end if;
  update public.tg_market_assistant_usage set calls=calls+1,reserved_micros=reserved_micros+cost,reserved_neurons=reserved_neurons+neurons where day=current_date;
  update public.tg_market_assistant_jobs set provider_reserved=true,usage_day=current_date,reserved_micros=cost,reserved_neurons=neurons where id=j.id;return jsonb_build_object('allowed',true);
 end if;
 if p_operation='ready' and j.state='processing' then
  if octet_length((p_data->'output')::text)>20000 then raise exception 'response too large';end if;
  update public.tg_market_assistant_jobs set state='ready',lease=null,output=p_data->'output',input_tokens=least(100000,greatest(0,coalesce((p_data->>'input_tokens')::int,0))),output_tokens=least(10000,greatest(0,coalesce((p_data->>'output_tokens')::int,0))),error_code=left(p_data->>'error_code',40) where id=j.id;
  if j.provider_reserved then update public.tg_market_assistant_usage set input_tokens=input_tokens+least(100000,greatest(0,coalesce((p_data->>'input_tokens')::int,0))),output_tokens=output_tokens+least(10000,greatest(0,coalesce((p_data->>'output_tokens')::int,0))) where day=coalesce(j.usage_day,j.created_at::date);end if;
  return '{}';
 end if;
 if p_operation='validate' and j.state='sending' then
  if exists(select 1 from public.tg_market_users where id=j.user_id and not banned) and j.expires_at>now() and (coalesce((j.output->>'ai')::boolean,false)=false or exists(select 1 from public.tg_market_intelligence_settings where assistant_enabled) and exists(select 1 from public.tg_market_assistant_sessions where user_id=j.user_id and ai_consent_at is not null)) then return jsonb_build_object('valid',true);end if;
  update public.tg_market_assistant_jobs set state='cancelled' where id=j.id;return jsonb_build_object('valid',false);
 end if;
 if p_operation='finish' and j.state='sending' then
  msg:=coalesce((p_data->>'message')::bigint,0);
  if p_data->>'outcome'='sent' and msg>0 then
   update public.tg_market_assistant_jobs set state='sent',message_id=msg where id=j.id;
   insert into public.tg_market_assistant_turns(user_id,job_id,question,answer) values(j.user_id,j.id,left(j.input,800),left(coalesce(j.output->>'context_answer',j.output->>'text'),1200)) on conflict(job_id) do nothing;
  elsif p_data->>'outcome'='rate_limited' then
   update public.tg_market_assistant_jobs set state='ready',lease=null where id=j.id;update public.tg_market_notify_control set next_send_at=now()+make_interval(secs=>least(86400,greatest(1,coalesce((p_data->>'retry_after')::int,30)))) where singleton;
  else update public.tg_market_assistant_jobs set state=case when p_data->>'outcome'='review' then 'review' else 'failed' end,error_code=left(p_data->>'outcome',40) where id=j.id;
   if p_data->>'outcome'='blocked' then update public.tg_market_learning_preferences set enabled=false where user_id=j.user_id;insert into public.tg_market_notify_preferences(user_id,blocked,enabled) values(j.user_id,true,false) on conflict(user_id) do update set blocked=true,enabled=false;end if;
  end if;return '{}';
 end if;
 if p_operation='send_slot' and j.state='sending' then
  perform 1 from public.tg_market_notify_control where singleton for update;
  if exists(select 1 from public.tg_market_notify_control where singleton and next_send_at>now()) then update public.tg_market_assistant_jobs set state='ready',lease=null where id=j.id;return jsonb_build_object('allowed',false);end if;
  update public.tg_market_notify_control set next_send_at=now()+interval '1.1 seconds' where singleton;return jsonb_build_object('allowed',true);
 end if;
 raise exception 'unknown assistant operation';
end$$;
create function public.tg_market_assistant_tools(p_actor bigint,p_operation text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.tg_market_users;cfg public.tg_market_settings;
begin
 select * into u from public.tg_market_users where telegram_id=p_actor;if u.id is null or u.banned then raise exception 'account unavailable';end if;
 if p_operation='account' then return jsonb_build_object('listings',coalesce((select jsonb_agg(to_jsonb(q)) from(select title,status,(approved_at is not null) as approved from public.tg_market_listings where owner_id=u.id and status<>'deleted' order by created_at desc limit 5)q),'[]'),'wanted',coalesce((select jsonb_agg(to_jsonb(q)) from(select title,case when expires_at<=now() then 'expired' else status end as status from public.tg_market_wanted where owner_id=u.id and status<>'deleted' order by created_at desc limit 5)q),'[]'),'radars',(select count(*) from public.tg_market_radars where owner_id=u.id and enabled));end if;
 if p_operation='diagnostics' then return jsonb_build_object('notifications_enabled',coalesce((select enabled from public.tg_market_notify_preferences where user_id=u.id),false),'paused',coalesce((select paused_until>now() from public.tg_market_notify_preferences where user_id=u.id),false),'blocked',coalesce((select blocked from public.tg_market_notify_preferences where user_id=u.id),false),'active_radars',(select count(*) from public.tg_market_radars where owner_id=u.id and enabled),'linked_waiting',(select count(*) from public.tg_market_radars r where r.owner_id=u.id and r.enabled and r.request_id is not null and not exists(select 1 from public.tg_market_wanted w where w.id=r.request_id and w.status='approved' and w.expires_at>now())),'upload_hour_limit',(select count(*)>=30 from public.tg_market_images where owner_id=u.id and created_at>now()-interval '1 hour'),'image_quota_limit',(select count(*)>=100 from public.tg_market_images where owner_id=u.id));end if;
 if p_operation='status' then select * into cfg from public.tg_market_settings where singleton;return jsonb_build_object('purchases_enabled',cfg.purchases_enabled and cfg.payments_verified,'channel_configured',cfg.channel_verified);end if;
 raise exception 'tool not allowed';
end$$;
revoke all on function public.tg_market_intelligence_action(bigint,text,jsonb,boolean,text),public.tg_market_guide_valid(uuid),public.tg_market_guide_worker(text,jsonb),public.tg_market_assist_search(jsonb),public.tg_market_assistant_worker(text,jsonb),public.tg_market_assistant_tools(bigint,text) from public,anon,authenticated,service_role;
grant execute on function public.tg_market_intelligence_action(bigint,text,jsonb,boolean,text),public.tg_market_guide_worker(text,jsonb),public.tg_market_assist_search(jsonb),public.tg_market_assistant_worker(text,jsonb),public.tg_market_assistant_tools(bigint,text) to service_role;
