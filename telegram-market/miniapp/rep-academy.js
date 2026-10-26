// Representative training is instructional UI, never an authorization source.
// Server-side market roles remain the only source of truth.
export const lessons=[
 {title:'شنو شغل مندوب وسيط؟',body:'تختار غرض مخصص للمندوبين وتسوّقه بصدق في الأماكن المسموح النشر بيها. ما تشتريه بنفسك، وإنما تجيب مشتري جاد وتوصل طلبه للإدارة.'},
 {title:'شلون أسوّق الإعلان؟',body:'راجع الصور والوصف والسعر والحالة والأضرار قبل المشاركة. لا توعد بميزات أو توصيل أو تخفيض غير متفق عليه، ولا تنشر بكروبات تمنع الإعلانات.'},
 {title:'لكيت مشتري، شنو أسوي؟',body:'تسجل اهتمام المشتري عبر النظام وتتواصل مع الإدارة. لا تأخذ عربون أو مبالغ باسم وسيط، ولا تعطي معلومات خاصة بدون موافقة صاحبها.'},
 {title:'شلون تنحسب العمولة؟',body:'العمولة المعتمدة يحددها المدير لكل عملية. ما تصير مستحقة إلا بعد إتمام البيع والتحقق منه، وتشوفها في صفحة المستحقات مع حالة الصرف.'},
 {title:'التعامل والأمان',body:'احترم البائع والمشتري، لا تخالف القانون، لا تنشر أرقام أو محادثات خاصة، لا تقدم إعلاناً مضللاً، ولا تستخدم حسابات وهمية. المخالفة ممكن تؤدي لتقييد الحساب.'}
];
const quiz=[
 {q:'إذا حصلت مشتري جاد، شتسوي؟',options:['أستلم عربون بنفسي','أسجل الطلب وأتواصل ويا الإدارة','أضمن البيع بدون الرجوع للمالك'],right:1},
 {q:'متى تصير العمولة مستحقة؟',options:['من أول مشاركة','بعد البيع والتحقق منه','من أول رسالة'],right:1},
 {q:'إذا بيانات الإعلان ناقصة، شنو تسوي؟',options:['أخمن التفاصيل','أتأكد من الإدارة قبل النشر','أكتب أي سعر'],right:1},
 {q:'أكدر أنشر رقم البائع بدون موافقته؟',options:['إي دائماً','فقط باذنه ووفق النظام','إذا كنت مندوب'],right:1},
 {q:'شنو التصرف الصحيح مع كروب يمنع الإعلانات؟',options:['أنشر رغم المنع','ألتزم بقوانين الكروب','أكرر الإعلان مرات'],right:1}
];
export function openRepAcademy({sheet,button,text,call,notice,onFinish}){
 let step=0,answers=[],agreed=false;
 function view(){
  const body=sheet('أكاديمية مندوب وسيط');
  const progress=Math.min(step+1,lessons.length);
  if(step<lessons.length){
   body.append(text('p','الدرس '+progress+' من '+lessons.length,'muted'),text('h2',lessons[step].title),text('p',lessons[step].body));
   if(step>0)body.append(button('السابق',()=>{step--;view()}));
   body.append(button(step===lessons.length-1?'ابدأ الاختبار':'الدرس التالي',()=>{step++;view()}));
   return;
  }
  body.append(text('h2','اختبار فهم العمل'),text('p','جاوب على الأسئلة الخمسة. النجاح من 4 إجابات صحيحة.','muted'));
  const form=document.createElement('form');
  quiz.forEach((item,i)=>{
   const group=document.createElement('fieldset');group.className='record';
   const legend=document.createElement('legend');legend.textContent=(i+1)+'. '+item.q;group.append(legend);
   item.options.forEach((answer,j)=>{const label=document.createElement('label');label.style.display='block';label.style.padding='6px';const input=document.createElement('input');input.type='radio';input.name='q'+i;input.value=String(j);input.required=true;label.append(input,document.createTextNode(' '+answer));group.append(label)});
   form.append(group);
  });
  const consent=document.createElement('label');consent.style.display='block';consent.style.margin='14px 0';const cb=document.createElement('input');cb.type='checkbox';cb.required=true;consent.append(cb,document.createTextNode(' قرأت التعليمات وأوافق على الالتزام بها.'));form.append(consent);
  const submit=document.createElement('button');submit.className='primary';submit.textContent='اعتماد نتيجة الاختبار';form.append(submit);
  form.onsubmit=e=>{e.preventDefault();const f=new FormData(form);answers=quiz.map((q,i)=>Number(f.get('q'+i)));const correct=answers.filter((a,i)=>a===quiz[i].right).length;if(correct<4){notice('النتيجة '+correct+'/5 — راجع الدروس وحاول مرة ثانية');step=0;view();return}agreed=cb.checked;const result=sheet('اجتزت اختبار المندوب ✅');result.append(text('h2','النتيجة '+correct+' من 5'),text('p','اكتمال التدريب لا يمنح صلاحية المندوب تلقائياً. لازم تقدم طلب للمدير وتنتظر الموافقة.'));result.append(button('قدّم طلب انضمام',()=>onFinish({score:correct,agreed})));};
  body.append(form,button('ارجع للدروس',()=>{step=0;view()}));
 }
 view();
}
