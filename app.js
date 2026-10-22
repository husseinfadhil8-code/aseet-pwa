const KEY = "waseet-demo-v1";
const initial = {goods:[], reps:[], sales:[]};
let data = load();
function load(){try{return {...initial,...JSON.parse(localStorage.getItem(KEY)||"{}")}}catch{return {...initial}}}
function save(){localStorage.setItem(KEY,JSON.stringify(data));render()}
function money(n){return new Intl.NumberFormat("ar-IQ").format(Number(n)||0)+" د.ع"}
function el(id){return document.getElementById(id)}
function toast(msg){const t=el("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2300)}
function showDialog(id){el(id).showModal()}
function hideDialog(id){el(id).close()}
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>hideDialog(b.dataset.close)));
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{
 document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));
 document.querySelectorAll(".view").forEach(x=>x.classList.add("hidden"));
 el(b.dataset.view+"View").classList.remove("hidden");
}));
el("addGoodsBtn").onclick=()=>showDialog("goodsDialog");
el("addRepBtn").onclick=()=>showDialog("repDialog");
el("addSaleBtn").onclick=()=>{
 if(!data.goods.length||!data.reps.length){toast("أضف غرضاً ومندوباً أولاً");return}
 populateSaleOptions();showDialog("saleDialog");
};
el("goodsForm").addEventListener("submit",e=>{
 e.preventDefault();const f=new FormData(e.target);
 data.goods.unshift({id:crypto.randomUUID(),title:f.get("title").trim(),price:+f.get("price"),area:f.get("area").trim(),commission:+f.get("commission"),notes:f.get("notes").trim(),status:"متاح"});
 e.target.reset();hideDialog("goodsDialog");save();toast("تم حفظ الغرض على هذا الجهاز");
});
el("repForm").addEventListener("submit",e=>{
 e.preventDefault();const f=new FormData(e.target);const code=f.get("code").trim();
 if(data.reps.some(r=>r.code.toLowerCase()===code.toLowerCase())){toast("رمز المندوب مستخدم، اختَر رمزاً آخر");return}
 data.reps.unshift({id:crypto.randomUUID(),name:f.get("name").trim(),code});
 e.target.reset();hideDialog("repDialog");save();toast("تم حفظ المندوب على هذا الجهاز");
});
function populateSaleOptions(){
 el("saleGoods").innerHTML=data.goods.filter(g=>g.status==="متاح").map(g=>`<option value="${g.id}">${esc(g.title)} — ${money(g.price)}</option>`).join("");
 el("saleRep").innerHTML=data.reps.map(r=>`<option value="${r.id}">${esc(r.name)} (${esc(r.code)})</option>`).join("");
 const g=data.goods.find(x=>x.id===el("saleGoods").value);el("saleForm").elements.commission.value=g?.commission||0;updateSplit();
}
function updateSplit(){const c=+el("saleForm").elements.commission.value||0;el("commissionSplit").textContent=`حصة المدير: ${money(Math.floor(c/2))} | حصة المندوب: ${money(c-Math.floor(c/2))}`}
el("saleGoods").addEventListener("change",()=>{const g=data.goods.find(x=>x.id===el("saleGoods").value);if(g)el("saleForm").elements.commission.value=g.commission;updateSplit()});
el("saleForm").elements.commission.addEventListener("input",updateSplit);
el("saleForm").addEventListener("submit",e=>{
 e.preventDefault();const f=new FormData(e.target),g=data.goods.find(x=>x.id===f.get("goodsId")),r=data.reps.find(x=>x.id===f.get("repId"));
 if(!g||!r){toast("تحقق من اختيار الغرض والمندوب");return}
 const commission=+f.get("commission");
 data.sales.unshift({id:crypto.randomUUID(),goodsTitle:g.title,repName:r.name,price:+f.get("price"),commission,managerShare:Math.floor(commission/2),repShare:commission-Math.floor(commission/2),date:new Date().toLocaleDateString("ar-IQ")});
 g.status="تم البيع";hideDialog("saleDialog");save();toast("تم تسجيل البيع في النسخة التجريبية");
});
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(){
 el("goodsCount").textContent=data.goods.length;el("repCount").textContent=data.reps.length;el("salesCount").textContent=data.sales.length;
 el("goodsList").innerHTML=data.goods.map(g=>`<article class="item"><div class="item-icon">▧</div><div class="item-main"><h3>${esc(g.title)}</h3><p>${esc(g.area||"الموقع غير محدد")} · عمولة ${money(g.commission)}</p>${g.notes?`<p>${esc(g.notes)}</p>`:""}<span class="pill">${esc(g.status)}</span></div><div class="price">${money(g.price)}</div></article>`).join("");
 el("repsList").innerHTML=data.reps.map(r=>`<article class="item"><div class="item-icon">♙</div><div class="item-main"><h3>${esc(r.name)}</h3><p>رمز المندوب: ${esc(r.code)}</p><span class="pill">مضاف للتجربة</span></div></article>`).join("");
 el("salesList").innerHTML=data.sales.map(s=>`<article class="item"><div class="item-icon">✓</div><div class="item-main"><h3>${esc(s.goodsTitle)}</h3><p>المندوب: ${esc(s.repName)} · ${esc(s.date)}</p><p>العمولة: ${money(s.commission)} (إلك ${money(s.managerShare)} / للمندوب ${money(s.repShare)})</p></div><div class="price">${money(s.price)}</div></article>`).join("");
 el("emptyGoods").classList.toggle("hidden",data.goods.length>0);el("emptyReps").classList.toggle("hidden",data.reps.length>0);el("emptySales").classList.toggle("hidden",data.sales.length>0);
}
if("serviceWorker" in navigator && location.protocol.startsWith("http"))window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
render();