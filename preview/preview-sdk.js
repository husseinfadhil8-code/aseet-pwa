/* Isolated design preview. No network transport, real keys, Auth or persistence. */
(() => {
  const id=(n,p='10000000')=>`${p}-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const now=()=>new Date().toISOString();
  const asset=name=>new URL('./assets/'+name,location.href).href;
  const admin={id:id(1,'20000000'),full_name:'مدير المعاينة',username:'demo_admin',role:'admin',status:'approved',permissions:{can_add_inquiry:true}};
  const rep={id:id(2,'20000000'),full_name:'مندوب المعاينة',username:'demo_rep',role:'rep',status:'approved',permissions:{can_add_inquiry:true}};
  const other={id:id(3,'20000000'),full_name:'سارة — حساب تجريبي',username:'demo_sara',role:'rep',status:'approved',permissions:{can_add_inquiry:true}};
  const pending={id:id(4,'20000000'),full_name:'طلب انضمام تجريبي',username:'demo_pending',role:'rep',status:'pending',permissions:{can_add_inquiry:true}};
  for(const row of [admin,rep,other,pending]){row.created_at='2025-01-01T00:00:00Z';row.username_locked=true;row.rep_code='DEMO-'+row.id.slice(-3);}
  const templates=[['طقم أثاث للمنزل','أثاث','room.jpg',275000],['هاتف ذكي بحالة ممتازة','هواتف','phone.jpg',185000],['حاسوب محمول للعمل والدراسة','إلكترونيات','laptop.jpg',620000],['كرسي عصري للمنزل','أثاث','chair.jpg',95000]];
  const items=Array.from({length:46},(_,i)=>{
    const [title,category,image,price]=templates[i%4];
    const photos=[asset(image),...(i===0?[asset('chair.jpg')]:[])];
    return {id:id(i+1),title:title+(i>3?' — عرض تجريبي '+(i+1):''),area:['بغداد · المنصور','البصرة · الجزائر','أربيل · عينكاوة'][i%3],asking_price:price,agreed_commission:25000,status:i===44?'reserved':i===45?'sold':'available',created_by:admin.id,created_at:new Date(Date.UTC(2026,9,24,12,0,0)-i*60000).toISOString(),description:`الصنف: ${category}\nحالة الغرض: مستعمل نظيف\nيوجد ضرر أو عطل: لا\nالتفاوض: قابل للتفاوض\nتفاصيل إضافية: بيانات وصور توضيحية لتجربة التصميم فقط، وليست إعلاناً حقيقياً.\nصور الغرض: ${photos.join(' | ')}`};
  });
  const group=id(1,'30000000');
  const store={profiles:[admin,rep,other,pending],goods:items,
    sales:[{id:id(1,'40000000'),goods_id:items[45].id,rep_id:rep.id,final_price:185000,total_commission:25000,rep_share:15000,manager_share:10000,verified_by:admin.id,verified_at:now(),created_at:now(),commission_paid_at:null}],
    inquiries:[{id:id(1,'50000000'),goods_id:items[0].id,rep_id:rep.id,buyer_name:'زبون تجريبي',buyer_phone:'غير حقيقي',status:'new',notes:'مثال لتصميم متابعة الاستفسارات',created_at:now()}],
    notifications:[admin,rep].flatMap(user=>[{id:id(user===admin?1:2,'60000000'),recipient_id:user.id,title:'أهلاً بك في معاينة وسيط',body:'كل ما تراه هنا بيانات تجريبية. لا توجد اتصالات بقاعدة البيانات.',category:'app_update',metadata:{},created_at:now(),read_at:null},{id:id(user===admin?3:4,'60000000'),recipient_id:user.id,title:'أغراض جديدة للمعاينة',body:'تصفّح الصور وافتح التفاصيل وجرّب البحث والتصفية.',category:'new_goods',metadata:{goods_id:items[0].id},created_at:now(),read_at:null}]),
    chat_conversations:[{id:group,kind:'group',title:'مجموعة المندوبين — معاينة',created_by:admin.id,created_at:now()}],
    chat_members:[admin,rep,other].map(user=>({conversation_id:group,user_id:user.id,last_read_at:'2026-01-01T00:00:00Z'})),
    chat_messages:Array.from({length:65},(_,i)=>({id:id(i+1,'70000000'),conversation_id:group,sender_id:i%2?rep.id:admin.id,body:i===64?'أهلاً بك! يمكنك تجربة الدردشة هنا دون إرسال أي رسالة حقيقية.':i===63?'الصور والأسعار في هذه النسخة توضيحية فقط.':'رسالة تجريبية '+(i+1)+' من سجل المحادثة.',created_at:new Date(Date.UTC(2026,9,24,10,0,i)).toISOString()})),
    external_listings:[],external_listing_claims:[],name_change_requests:[],push_subscriptions:[]};
  let sessionUser=null;
  const authListeners=[];
  const unavailable=()=>Promise.resolve({data:null,error:{message:'المعاينة لا تقبل حسابات أو كلمات مرور حقيقية. اختر تجربة المدير أو المندوب.'}});
  const clone=value=>JSON.parse(JSON.stringify(value));
  const isAdmin=()=>sessionUser?.id===admin.id;
  const safeRows=table=>{
    const rows=store[table]||[];
    if(!sessionUser)return [];
    if(table==='notifications')return rows.filter(r=>r.recipient_id===sessionUser.id);
    if(table==='sales'&&!isAdmin())return rows.filter(r=>r.rep_id===sessionUser.id);
    if(table==='profiles'&&!isAdmin())return rows.filter(r=>r.id===sessionUser.id);
    if(table==='inquiries'&&!isAdmin())return rows.filter(r=>r.rep_id===sessionUser.id);
    return rows;
  };
  function query(table){
    let action='select',payload=null,filters=[],sort=[],cap=Infinity,single=false;
    const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},not(k,operator,v){filters.push(r=>operator==='is'&&v===null?r[k]!=null:r[k]!==v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},is(k,v){filters.push(r=>r[k]===v || (v===null&&r[k]==null));return q;},lte(k,v){filters.push(r=>Number(r[k])<=Number(v));return q;},ilike(k,v){const value=v.replaceAll('%','').replaceAll('\\','').toLowerCase();filters.push(r=>String(r[k]||'').toLowerCase().includes(value));return q;},order(k,options={}){sort.push([k,options.ascending!==false]);return q;},limit(n){cap=n;return q;},single(){single=true;return q;},maybeSingle(){single=true;return q;},insert(value){action='insert';payload=value;return q;},update(value){action='update';payload=value;return q;},delete(){action='delete';return q;},upsert(){return {then:resolve=>resolve({data:null,error:{message:'إعدادات الحساب الحقيقية غير متاحة في المعاينة.'}})};},
      or(value){
        if(value.startsWith('created_at.lt.')){
          const match=value.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.[^,]+,id\.lt\.([^()]+)\)$/);
          if(match)filters.push(r=>r.created_at<match[1] || (r.created_at===match[1]&&r.id<match[2]));
        }else{
          const match=value.match(/title\.ilike\.("(?:\\.|[^"\\])*")/);
          if(match){let text='';try{text=JSON.parse(match[1]).replace(/^\*|\*$/g,'').replaceAll('\\','').toLowerCase();}catch(_){}
            filters.push(r=>[r.title,r.area,r.description].join(' ').toLowerCase().includes(text));}
        }
        return q;
      },
      then(resolve,reject){return Promise.resolve().then(()=>{
        let result=safeRows(table).filter(r=>filters.every(test=>test(r)));
        if(action!=='select'){
          if(!sessionUser || (!isAdmin()&&!['chat_messages','chat_members','inquiries'].includes(table)))return {data:null,error:{message:'هذا الإجراء غير متاح لهذا الدور في المعاينة.'}};
          if(action==='insert'){
            const rows=(Array.isArray(payload)?payload:[payload]).map(row=>({...row,id:row.id||crypto.randomUUID(),created_at:row.created_at||now()}));
            (store[table] ||= []).push(...rows);result=rows;
          }else if(action==='update'){result.forEach(row=>Object.assign(row,payload));}
          else {store[table]=(store[table]||[]).filter(row=>!result.includes(row));}
        }
        const count=result.length;
        result=[...result].sort((a,b)=>{for(const [field,asc] of sort){if(a[field]!==b[field])return (a[field]>b[field]?1:-1)*(asc?1:-1);}return 0;}).slice(0,cap);
        return {data:clone(single?(result[0]||null):result),count,error:null};
      }).then(resolve,reject);}
    };
    return q;
  }
  async function rpc(name,args={}){
    if(!sessionUser)return {data:null,error:{message:'اختر دوراً لتجربة المعاينة.'}};
    if(name==='ensure_chat_ready')return {data:group,error:null};
    if(name==='get_chat_people')return {data:clone([admin,rep,other]),error:null};
    if(name==='get_name_change_requests')return {data:[],error:null};
    if(name==='has_pending_name_change_request')return {data:false,error:null};
    if(name==='mark_notification_read'){const row=store.notifications.find(n=>n.id===args.p_notification_id&&n.recipient_id===sessionUser.id);if(row)row.read_at=now();return {error:null};}
    if(name==='record_sale' && isAdmin()){
      const good=store.goods.find(g=>g.id===args.p_goods_id);
      if(!good||good.status!=='available')return {error:{message:'الغرض التجريبي غير متاح للبيع.'}};
      good.status='sold';const row={id:crypto.randomUUID(),goods_id:good.id,rep_id:args.p_rep_id,final_price:args.p_final_price,total_commission:args.p_total_commission,rep_share:args.p_rep_share,manager_share:args.p_total_commission-args.p_rep_share,verified_by:admin.id,created_at:now()};store.sales.push(row);return {data:row.id,error:null};
    }
    if(name==='mark_sale_commission_paid' && isAdmin()){const row=store.sales.find(s=>s.id===args.p_sale_id);if(row)row.commission_paid_at=now();return {error:null};}
    if(name==='create_direct_chat')return {data:group,error:null};
    return {data:null,error:{message:'هذه الميزة تحتاج اتصالاً حقيقياً، وهي معطلة في المعاينة.'}};
  }
  const client={from:query,rpc,auth:{getSession:async()=>({data:{session:null},error:null}),onAuthStateChange(fn){authListeners.push(fn);return {data:{subscription:{unsubscribe(){}}}};},signOut:async()=>{sessionUser=null;authListeners.forEach(fn=>fn('SIGNED_OUT'));return {error:null};},signInWithPassword:unavailable,signUp:unavailable,resetPasswordForEmail:unavailable,updateUser:unavailable},functions:{invoke:async()=>({data:null,error:{message:'Push والبريد والخدمات المستضافة معطلة في المعاينة.'}})},storage:{from:()=>({upload:async()=>({error:{message:'رفع الملفات للخادم غير متاح في معاينة التصميم.'}}),getPublicUrl:()=>({data:{publicUrl:asset('chair.jpg')}})})}};
  window.supabase={createClient(url,key){if(url!=='https://preview.invalid'||key!=='preview-offline')throw new Error('Preview refuses real backend configuration');return client;}};
  window.WaseetPreview={enter(role){const row=role==='admin'?admin:rep;sessionUser={id:row.id,email:role+'@preview.invalid',created_at:row.created_at,user_metadata:{}};return {user:clone(sessionUser),profile:clone(row)};},reset(){sessionUser=null;},source:'32b5921'};
})();
