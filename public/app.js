// Zaiqa v2 SPA — same API, same rules, same routes as FoodScope v1.
// Only the look changed: rebuilt in the "Tap. Order. Eat." reel's design language
// (green gradient header, mint hero, circular categories, deal cards,
// delivery rail, restaurant grid, map-first vendor sheet, bottom nav).
// No code copied from the reel — this is an original implementation.
let csrfToken = null, me = null, vendorsCache = [];
const state = { q: '', cat: '', city: '', sort: '', openOnly: false };
let savedIds = new Set();
const cart = {};
let cartVendorId = null;
const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const FALLBACK_IMG = 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800';
const CAT_PHOTOS = {
  'All': 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=200',
  'Desi': 'https://images.unsplash.com/photo-1589302168068-964664d93dc0?w=200',
  'BBQ': 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=200',
  'Karahi': 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=200',
  'Fast Food': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=200',
  'Sweets': 'https://images.unsplash.com/photo-1551024506-0bccd828d307?w=200',
  'Chinese': 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?w=200',
  'Bakery': 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=200',
  'Beverages': 'https://images.unsplash.com/photo-1544145945-f90425340c7e?w=200',
};
const DEAL_PHOTOS = {
  'Basic': 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800',
  'Premium': 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=800',
  'Featured': 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=800',
};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function imgTag(src, cls, alt){
  return `<img src="${esc(src||FALLBACK_IMG)}" class="${cls||''}" alt="${esc(alt||'')}" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">`;
}
async function getCsrf(){
  const r = await fetch('/api/csrf', {credentials:'include'});
  const j = await r.json(); csrfToken = j.csrfToken; return csrfToken;
}
async function api(method, path, body){
  const opts = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
  if(['POST','PATCH','PUT','DELETE'].includes(method)){
    const exempt = ['/api/auth/login','/api/auth/register-customer','/api/auth/verify','/api/auth/request-code','/api/auth/login-verify','/api/auth/login-resend','/api/auth/manager-setup'].includes(path);
    if(!exempt){ if(!csrfToken) await getCsrf(); opts.headers['X-CSRF-Token']=csrfToken; }
    if(body!==undefined) opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const j = await r.json().catch(()=>({error:'Bad response'}));
  if(!r.ok) throw new Error(j.error || ('Request failed ('+r.status+')'));
  return j;
}
async function refreshMe(){
  try{ const j = await fetch('/api/auth/me',{credentials:'include'}).then(r=>r.json()); me=j.user; csrfToken=j.csrfToken||csrfToken; }catch(e){ me=null; }
  const av = document.getElementById('avatarBox');
  if(av) av.textContent = me ? (me.name||'Z').trim()[0].toUpperCase() : 'Z';
  updateBellDot();
  if (me && me.role === 'customer') { try { const j = await fetch('/api/saved', {credentials:'include'}).then(r=>r.json()); savedIds = new Set((j.vendors||[]).map(v=>v.id)); } catch(e){ savedIds = new Set(); } }
  else savedIds = new Set();
}
async function updateBellDot(){
  const dot = document.getElementById('bellDot');
  if(!dot) return;
  dot.hidden = true;
  if(!me) return;
  try{
    if(me.role === 'owner'){
      const rep = await api('GET','/api/admin/reports');
      if(rep.totals && rep.totals.vendors_pending > 0) dot.hidden = false;
    } else if(me.role === 'manager'){
      const j = await api('GET','/api/manager/vendor');
      if(j.vendor){
        const pending = (j.vendor.payments||[]).some(p=>p.status==='pending') ||
          (j.vendor.update_requests||[]).some(r=>r.status==='pending');
        if(pending) dot.hidden = false;
      }
    }
  }catch(e){ /* bell dot is best-effort only */ }
}
document.getElementById('bellBtn').onclick = ()=>{
  location.hash = me ? '#/account' : '#/login';
};
async function logout(){ try{ await api('POST','/api/auth/logout',{}); }catch(e){} me=null; location.hash='#/'; render(); }
function animateCounters(){
  document.querySelectorAll('[data-count]').forEach(el=>{
    const target=Number(el.dataset.count)||0; let cur=0;
    const step=()=>{ cur+=Math.max(1,Math.round(target/25)); if(cur>=target) el.textContent=target; else { el.textContent=cur; requestAnimationFrame(step); } };
    step();
  });
}
function drawChart(canvas, labels, values){
  if(!canvas) return; const ctx=canvas.getContext('2d');
  const W=canvas.width=canvas.offsetWidth*2, H=canvas.height=440;
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#e6f4e3'; ctx.fillRect(0,0,W,H);
  const max=Math.max(1,...values); const bw=W/(values.length*1.6);
  values.forEach((v,i)=>{ const h=(v/max)*(H-90); const x=20+i*(bw*1.6)+10;
    ctx.fillStyle='#43a047'; ctx.fillRect(x,H-50-h,bw,h);
    ctx.fillStyle='#1d241a'; ctx.font='22px sans-serif'; ctx.fillText(String(v),x,H-60-h);
    ctx.fillStyle='#6b7280'; ctx.font='20px sans-serif'; ctx.fillText(String(labels[i]).slice(0,12),x,H-18);
  });
}
function stars(n){ if(n==null) return '<span class="muted">No ratings yet</span>'; return '<span class="stars">★ '+n+'/5</span>'; }
const app=document.getElementById('app');
// Render generation: a slow page must never paint over a newer one.
// render() bumps renderSeq on every navigation; each async page checks
// its token right before writing #app and bails if a newer render began.
let renderSeq = 0;
function paint(my, html){ if (my === renderSeq) app.innerHTML = html; }

function setActiveNav(){
  const hash=(location.hash.replace(/^#\//,'')||'').split('/')[0];
  const map={'':'home','vendor':'home','offers':'offers','manager':'manager','account':'profile','login':'profile','register':'profile','saved':'saved'};
  const active=map[hash]||'home';
  document.querySelectorAll('[data-bnav]').forEach(a=>{ a.classList.toggle('active', a.dataset.bnav===active); });
}
async function render(){
  const my = ++renderSeq;
  // Clear the old page at once: without this, the previous page stays
  // visible while refreshMe() + the new page's fetches are still running
  // (seen as a stale-render flash when tapping Home from another page).
  app.innerHTML='';
  setActiveNav(); await refreshMe();
  if (my !== renderSeq) return;
  // Plans are manager-only: hide the Plans tab for everyone else.
  const offersNav=document.querySelector('[data-bnav="offers"]');
  if(offersNav) offersNav.style.display=(me && me.role==='manager')?'':'none';
  const hero=document.getElementById('homeHero');
  const hash0=location.hash.replace(/^#\//,'')||'';
  if(hero) hero.hidden = !(hash0==='' );
  const floatEl=document.getElementById('floatOrder');
  if(floatEl && hash0!=='') floatEl.hidden = true;
  const hash=location.hash.replace(/^#\//,'')||'';
  const [route, param] = hash.split('/');
  try{
    if(route==='' ) return renderHome(my);
    if(route==='vendor') return renderVendor(param, my);
    if(route==='offers') return renderOffers(my);
    if(route==='saved') return renderSaved(my);
    if(route==='about') return renderStatic('About Zaiqa','<p>Zaiqa is a public directory of Pakistani food businesses — from Peshawari chapli kabab houses to Burns Road nihari, Lahore karahi and sweet shops. Only approved vendors with a current subscription appear in the public directory.</p><p>Managers submit one vendor listing, pay for a subscription plan, and upload legal certificates. The Portal Admin reviews every payment, certificate, vendor and sensitive update before it goes live.</p>');
    if(route==='contact') return renderContact();
    if(route==='privacy') return renderStatic('Privacy Policy','<p>Zaiqa stores only what the directory needs: account names, one contact channel per customer, vendor business details, reviews and messages. Passwords are stored as salted PBKDF2 hashes; session tokens are hashed. We do not sell personal data.</p>');
    if(route==='terms') return renderStatic('Terms of Use','<p>Listings must be real food businesses. Reviews must be honest and must not contain abuse, threats, spam or private contact details — flagged reviews are moderated. Vendors are responsible for their menu prices and delivery promises.</p>');
    if(route==='login') return renderLogin();
    if(route==='register') return renderRegister();
    if(route==='manager') return renderManager(my);
    if(route==='admin') return renderAdmin(my);
    if(route==='account') return renderAccount();
    app.innerHTML='<p>Page not found. <a href="#/">Back to directory</a></p>';
  }catch(e){ paint(my, `<div class="err">${esc(e.message)}</div>`); }
}
async function loadVendors(){
  const params=new URLSearchParams();
  if(state.cat) params.set('category',state.cat);
  if(state.city) params.set('city',state.city);
  const j=await fetch('/api/vendors?'+params.toString()).then(r=>r.json());
  vendorsCache=j.vendors||[]; return vendorsCache;
}
window.scrollToVendors=()=>{ const el=document.getElementById('vendorsGrid'); if(el) el.scrollIntoView({behavior:'smooth'}); };
window.focusSearch=()=>{ const el=document.getElementById('topSearch'); if(el){ el.focus(); el.scrollIntoView({behavior:'smooth',block:'center'}); } return false; };
window.applyFilters=()=>{ const s=document.getElementById('topSearch'); state.q=s?s.value.trim():''; renderHome(); };
document.getElementById('topSearch').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); applyFilters(); } });
function buildCityMenu(){
  const menu=document.getElementById('cityMenu'); if(!menu) return;
  const majors=['','Lahore','Karachi','Peshawar','Islamabad'];
  const seen=new Set(majors);
  (vendorsCache||[]).forEach(v=>{ if(v.city) seen.add(v.city); });
  const cities=[...seen];
  menu.innerHTML=cities.map(c=>`<button type="button" onclick="setCity('${esc(c)}')">${c===''?'All Pakistan':esc(c)}</button>`).join('');
}
document.getElementById('deliverCityBtn').onclick=(e)=>{
  e.stopPropagation();
  buildCityMenu();
  const menu=document.getElementById('cityMenu');
  menu.hidden=!menu.hidden;
};
document.addEventListener('click',e=>{
  const menu=document.getElementById('cityMenu');
  if(menu && !menu.hidden && !e.target.closest('#cityMenu') && !e.target.closest('#deliverCityBtn')) menu.hidden=true;
});
window.setCity=(city)=>{
  state.city=city||'';
  document.getElementById('deliverCityText').textContent = state.city||'All Pakistan';
  const menu=document.getElementById('cityMenu'); if(menu) menu.hidden=true;
  renderHome();
};
window.setCategory=(cat)=>{ state.cat=cat||''; renderHome(); };
function priceRangeText(menu){
  const prices=(menu||[]).map(m=>Number(m.price_pkr)).filter(n=>Number.isFinite(n));
  if(!prices.length) return 'Prices on menu page';
  const lo=Math.min(...prices), hi=Math.max(...prices);
  return lo===hi ? ('PKR '+lo) : ('PKR '+lo+' – '+hi);
}
const detailsCache = new Map();
async function getVendorDetails(v){
  if(detailsCache.has(v.id)) return detailsCache.get(v.id);
  let d = { priceText: 'Prices on menu page', dishes: [], menuLastUpdated: null };
  try{ const j=await fetch('/api/vendors/'+v.id).then(r=>r.json()); if(j.vendor && j.vendor.menu){ d.priceText = priceRangeText(j.vendor.menu); d.dishes = j.vendor.menu.filter(m=>m.available).map(m=>({id:m.id,name:m.name,price:m.price_pkr})); d.menuLastUpdated = j.vendor.menu_last_updated; } }catch(e){}
  detailsCache.set(v.id, d); return d;
}
async function priceRangeFor(v){
  try{ const j=await fetch('/api/vendors/'+v.id).then(r=>r.json()); if(j.vendor && j.vendor.menu) return priceRangeText(j.vendor.menu); }catch(e){}
  return 'Prices on menu page';
}
function vendorCard(v, priceText, dishLine){
  const img=v.primary_image_url||FALLBACK_IMG;
  const del = v.delivery_enabled ? (v.delivery_time ? esc(v.delivery_time) : 'Delivery available') : 'Dine-in / takeaway';
  const planBadge = v.subscription_plan ? `<span class="off-badge">${esc(v.subscription_plan)}</span>` : '';
  const saved = savedIds.has(v.id);
  const openLine = v.open_now ? `<span style="color:var(--green-dark);font-weight:700">● Open now${v.closes_at?(' · closes '+esc(v.closes_at)):''}</span>` : `<span class="muted">Closed${v.opens_at?(' · opens '+esc(v.opens_at)):''}</span>`;
  return `<div class="vendor">${planBadge}<a href="#/vendor/${v.id}">${imgTag(img,'vimg',v.name)}</a><div class="vbody">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><h3 style="margin:0"><a href="#/vendor/${v.id}">${esc(v.name)}</a></h3>
    <button class="heart-btn${saved?' saved':''}" type="button" onclick="toggleSave(${v.id}, event)" title="${saved?'Saved — tap to remove':'Save this place'}" aria-label="Save">${saved?'♥':'♡'}</button></div>
    <div><span class="badge">${esc(v.category)}</span><span class="badge">${esc(v.city)}</span>${v.delivery_enabled?'<span class="badge">Delivery</span>':''}${v.halal_verified?'<span class="badge halal">✓ Halal verified</span>':v.halal_declared?'<span class="badge">Halal</span>':''}</div>
    <p class="vmeta">${stars(v.ratings.overall)} · ${v.ratings.count} reviews</p>
    <p class="vmeta">${openLine}</p>
    ${dishLine||''}
    <p class="vdesc">${esc((v.description||'').slice(0,110))}</p>
    <p><span class="price">${esc(priceText||'Prices on menu page')}</span> <span class="muted">· ${del}</span></p></div></div>`;
}

function dealCard(plan, price, days, tagline){
  return `<div class="deal-card"><img src="${esc(DEAL_PHOTOS[plan]||FALLBACK_IMG)}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">
    <div class="deal-body"><h3>${esc(tagline)}</h3><p>${esc(plan)} plan · ${days} days · PKR ${Number(price).toLocaleString()}</p>
    <div class="deal-row"><span style="font-weight:700">${esc(plan)}</span><a class="claim-btn" href="#/manager">Claim</a></div></div></div>`;
}
async function renderHome(my){ my = my ?? ++renderSeq;
  const cats=await fetch('/api/categories').then(r=>r.json()).catch(()=>({categories:[]}));
  const list=await loadVendors();
  detailsCache.clear();
  const details = await Promise.all(list.map(v=>getVendorDetails(v)));
  const q = state.q.toLowerCase();
  let shown = list.map((v,i)=>({v, d:details[i]}));
  if(q){
    shown = shown.filter(({v,d})=>{
      const hay = [v.name, v.description, v.city, v.area, v.category].join(' ').toLowerCase();
      return hay.includes(q) || d.dishes.some(di=>di.name.toLowerCase().includes(q));
    });
  }
  if(state.openOnly) shown = shown.filter(({v})=>v.open_now);
  const sort=state.sort;
  if(sort==='rating') shown.sort((a,b)=>(b.v.ratings.overall??-1)-(a.v.ratings.overall??-1));
  else if(sort==='reviews') shown.sort((a,b)=>b.v.ratings.count-a.v.ratings.count);
  else if(sort==='name') shown.sort((a,b)=>a.v.name.localeCompare(b.v.name));
  const total=list.length;
  const cards = shown.map(({v,d})=>{
    let dishLine='';
    if(q){ const hit=d.dishes.find(di=>di.name.toLowerCase().includes(q)); if(hit) dishLine=`<p class="dish-match">Serves: ${esc(hit.name)} — PKR ${hit.price}</p>`; }
    return vendorCard(v, d.priceText, dishLine);
  });
  const fast = shown.filter(({v})=>v.delivery_enabled);
  const fastCards = fast.slice(0,8).map(({v,d})=>vendorCard(v, d.priceText, ''));
  const catList=['', ...(cats.categories||[])];
  const catRow = catList.map(c=>{
    const photo=CAT_PHOTOS[c]||CAT_PHOTOS['All'];
    return `<button type="button" class="cat-item${state.cat===c?' active':''}" onclick="setCategory('${esc(c)}')"><img class="cat-img" src="${esc(photo)}" alt="${esc(c||'All')}" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'"><span>${c===''?'All':esc(c)}</span></button>`;
  }).join('');
  // Plans live only on the dedicated Plans page (#/offers) — they are for
  // restaurants, not for customers browsing food on the home page.
  paint(my, `
  <div class="stat-chips">
    <span class="stat-chip"><b data-count="${total}">0</b> approved vendors</span>
    <span class="stat-chip"><b data-count="${list.reduce((a,v)=>a+v.ratings.count,0)}">0</b> customer reviews</span>
    <span class="stat-chip"><b data-count="${new Set(list.map(v=>v.city)).size}">0</b> cities covered</span>
  </div>
  <div class="section-head"><h2>Categories</h2><button class="see-all" type="button" onclick="setCategory('')">See All</button></div>
  <div class="cat-row">${catRow}</div>
  ${fast.length?`<div class="section-head"><h2>Delivery available</h2></div><div class="hscroll">${fastCards.join('')}</div>`:''}
  <div class="section-head" id="vendorsGrid"><h2>Restaurants</h2>
    <span style="display:flex;gap:8px;align-items:center"><button class="small${state.openOnly?'':' ghost'}" type="button" onclick="toggleOpenOnly()">${state.openOnly?'● Open now only':'Open now only'}</button>
    <select id="sortSel" style="width:auto" onchange="setSort(this.value)">
      <option value="">Sort: Featured</option>
      <option value="rating"${sort==='rating'?' selected':''}>Top rated</option>
      <option value="reviews"${sort==='reviews'?' selected':''}>Most reviewed</option>
      <option value="name"${sort==='name'?' selected':''}>Name A–Z</option>
    </select></span></div>
  <div class="grid">${cards.length?cards.join(''):'<p class="muted">No vendors match those filters yet.</p>'}</div>
  <div class="panel"><h3 style="margin-top:0">Activity: reviews per vendor</h3><canvas id="chart"></canvas><p class="muted">Live counts from the public directory.</p></div>
  <div class="panel"><h3>📬 Zaiqa newsletter</h3><form onsubmit="subscribe(event)"><label>Email</label><input name="email" type="email" required placeholder="you@example.com"><button class="btn" style="margin-top:10px">Subscribe</button><span id="nlMsg" class="muted"></span></form>
  <p class="muted" style="font-size:13px">One email a week with new places. No spam.</p></div>`);
  animateCounters();
  drawChart(document.getElementById('chart'), list.map(v=>v.name), list.map(v=>v.ratings.count));
  showTopRated(list);
}

window.setSort=(val)=>{ state.sort=val||''; renderHome(); };
window.toggleOpenOnly=()=>{ state.openOnly=!state.openOnly; renderHome(); };
window.toggleSave=async(id, ev)=>{
  if(ev) ev.preventDefault();
  if(!me){ location.hash='#/login'; return; }
  if(me.role!=='customer'){ alert('Saving places is for customer accounts. Log in as a customer to save.'); return; }
  try{
    const j=await api('POST','/api/saved/'+id,{});
    if(j.saved) savedIds.add(id); else savedIds.delete(id);
    render();
  }catch(e){ alert(e.message); }
};
window.cartAdd=(id, delta)=>{
  const item=(window.__menu||[]).find(m=>m.id===id); if(!item) return;
  cart[id]=Math.max(0,(cart[id]||0)+delta);
  if(cart[id]===0) delete cart[id];
  const el=document.getElementById('qty-'+id); if(el) el.textContent=cart[id]||0;
  renderCartBar();
};
window.cartClear=()=>{ for(const k of Object.keys(cart)) delete cart[k]; document.querySelectorAll('[id^="qty-"]').forEach(el=>el.textContent='0'); renderCartBar(); };
function cartTotal(){ return (window.__menu||[]).reduce((a,m)=>a+(cart[m.id]||0)*m.price_pkr,0); }
function renderCartBar(){
  const bar=document.getElementById('cartBar'); if(!bar) return;
  const n=Object.values(cart).reduce((a,b)=>a+b,0);
  const v=window.__vendor;
  if(!n || !v){ bar.hidden=true; return; }
  const total=cartTotal();
  const lines=(window.__menu||[]).filter(m=>cart[m.id]).map(m=>`${cart[m.id]}x ${m.name} (PKR ${m.price_pkr})`).join('\n');
  let digits=((v.delivery_phone||'').replace(/[^\d]/g,''));
  if(digits.startsWith('0')) digits='92'+digits.slice(1);
  const fee = v.delivery_enabled ? (Number(v.delivery_fee_pkr)||0) : 0;
  const msg=`Hello ${v.name}! I would like to order:\n${lines}\n\nItems total: PKR ${total}${fee?`\nDelivery fee: PKR ${fee}\nGrand total: PKR ${total+fee}`:''}\nPayment: Cash on Delivery`;
  const wa=digits?`https://wa.me/${digits}?text=${encodeURIComponent(msg)}`:null;
  bar.innerHTML=`<div><b>${n} item${n>1?'s':''} · PKR ${fee?total+fee:total}</b>${fee?`<br><span class="muted">Includes PKR ${fee} delivery fee</span>`:''}<br><span class="muted">Payment: Cash on Delivery · direct to the restaurant, no commission</span></div>
  ${wa?`<a class="btn" href="${wa}" target="_blank" rel="noopener">Order on WhatsApp</a>`:`<span class="muted">No WhatsApp number listed for this restaurant.</span>`}
  <button class="small ghost" onclick="cartClear()">Clear</button>`;
  bar.hidden=false;
}
// In-page form modal (replaces window.prompt, which some browsers and
// webviews suppress silently — a report typed into a prompt that never
// appears is a report that never gets sent). Returns the submitted values
// as an object, or null when the user cancels.
function openFormModal(title, fields, submitLabel){
  return new Promise((resolve)=>{
    const old=document.getElementById('zqModal'); if(old) old.remove();
    const overlay=document.createElement('div');
    overlay.id='zqModal';
    overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px';
    const card=document.createElement('div');
    card.style.cssText='background:#fff;border-radius:16px;max-width:480px;width:100%;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.3)';
    card.innerHTML=`<h3 style="margin:0 0 12px">${esc(title)}</h3>`;
    const form=document.createElement('form');
    for(const f of fields){
      const wrap=document.createElement('div'); wrap.style.marginBottom='12px';
      const lab=document.createElement('label'); lab.textContent=f.label; lab.style.cssText='display:block;font-weight:600;margin-bottom:4px';
      wrap.appendChild(lab);
      let input;
      if(f.type==='textarea'){ input=document.createElement('textarea'); input.rows=3; }
      else if(f.type==='select'){ input=document.createElement('select'); for(const o of (f.options||[])){ const op=document.createElement('option'); op.value=o.value; op.textContent=o.label; if(o.value===f.value) op.selected=true; input.appendChild(op); } }
      else { input=document.createElement('input'); input.type='text'; }
      input.name=f.key; input.style.cssText='width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:10px;font:inherit';
      if(f.placeholder) input.placeholder=f.placeholder;
      if(f.value && f.type!=='select') input.value=f.value;
      if(f.required) input.required=true;
      wrap.appendChild(input); form.appendChild(wrap);
    }
    const row=document.createElement('div'); row.style.cssText='display:flex;gap:10px;justify-content:flex-end;margin-top:16px';
    const cancel=document.createElement('button'); cancel.type='button'; cancel.textContent='Cancel'; cancel.className='small ghost';
    const submit=document.createElement('button'); submit.type='submit'; submit.textContent=submitLabel||'Send'; submit.className='btn';
    row.appendChild(cancel); row.appendChild(submit); form.appendChild(row);
    const msg=document.createElement('div'); msg.className='muted'; msg.style.marginTop='10px'; form.appendChild(msg);
    card.appendChild(form); overlay.appendChild(card); document.body.appendChild(overlay);
    const close=(val)=>{ overlay.remove(); resolve(val); };
    cancel.onclick=()=>close(null);
    overlay.addEventListener('click',e=>{ if(e.target===overlay) close(null); });
    form.onsubmit=(e)=>{ e.preventDefault();
      const out={}; let ok=true;
      for(const f of fields){ const el=form.elements[f.key]; out[f.key]=(el.value||'').trim(); if(f.required && !out[f.key]) ok=false; }
      if(!ok){ msg.textContent='Please fill in the required fields.'; return; }
      close(out);
    };
    const first=form.querySelector('input,textarea,select'); if(first) first.focus();
  });
}
window.reportListing=async(vendorId, type, menuItemId)=>{
  const vals=await openFormModal('Report this listing', [
    {key:'type', label:'What is wrong?', type:'select', value:type, options:[
      {value:'wrong_price', label:'Wrong price'},
      {value:'wrong_phone', label:'Wrong phone number'},
      {value:'closed', label:'Shop is closed'},
      {value:'moved', label:'Shop moved'},
      {value:'wrong_info', label:'Wrong info'},
      {value:'other', label:'Something else'}]},
    {key:'message', label: type==='wrong_price' ? 'What is wrong with this price? (e.g. listed PKR 450, counter charges PKR 500)' : 'Tell us what is wrong (5-500 characters)', type:'textarea', required:true, placeholder:'e.g. listed PKR 450, counter charges PKR 500'},
  ], 'Send report');
  if(!vals) return;
  try{ await api('POST','/api/reports',{vendor_id:vendorId, menu_item_id:menuItemId||undefined, type:vals.type, message:vals.message}); alert('Thanks — your report is with the Portal Admin.'); }
  catch(e){ alert(e.message); }
};
window.shareVendor=async(id)=>{ const url=location.origin+'/#/vendor/'+id; try{ await navigator.clipboard.writeText(url); alert('Link copied: '+url); }catch(e){ await openFormModal('Copy this link', [{key:'url', label:'Link', type:'text', value:url}], 'Done'); } };
async function renderSaved(my){ my = my ?? ++renderSeq;
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> as a customer to save places.</p>'; return; }
  if(me.role!=='customer'){ app.innerHTML='<p>Saved places are for customer accounts. Your role: '+esc(me.role)+'</p>'; return; }
  const j=await api('GET','/api/saved');
  const list=j.vendors||[];
  const details=await Promise.all(list.map(v=>getVendorDetails(v)));
  paint(my, `<h1>Saved places</h1><p class="muted">Your favourite restaurants — tap the heart again on any card to remove it.</p>
  <div class="grid">${list.length?list.map((v,i)=>vendorCard(v, details[i].priceText, '')).join(''):'<p class="muted">Nothing saved yet. Tap ♡ on any restaurant to save it here.</p>'}</div>`);
}
function showTopRated(list){
  const el=document.getElementById('floatOrder'); if(!el) return;
  const rated=list.filter(v=>v.ratings.overall!=null).sort((a,b)=>(b.ratings.overall-a.ratings.overall)||(b.ratings.count-a.ratings.count));
  if(!rated.length){ el.hidden=true; return; }
  const v=rated[0];
  el.innerHTML=`<a href="#/vendor/${v.id}">${imgTag(v.primary_image_url||FALLBACK_IMG,'',v.name)}</a>
    <div class="fo-body"><div class="fo-title"><span class="live-dot"></span>Top rated</div>
    <div class="fo-sub">${esc(v.name)} · ★ ${v.ratings.overall} · ${esc(v.delivery_time||v.city)}</div></div>
    <button class="fo-close" type="button" onclick="document.getElementById('floatOrder').hidden=true" aria-label="Dismiss">✕</button>`;
  el.hidden=false;
}
window.subscribe=async(e)=>{ e.preventDefault(); const email=e.target.email.value;
  try{ const j=await api('POST','/api/newsletter',{email}); document.getElementById('nlMsg').textContent=' ✓ '+j.message; }
  catch(err){ document.getElementById('nlMsg').textContent=' ✗ '+err.message; } };
async function renderVendor(id, my){ my = my ?? ++renderSeq;
  const j=await fetch('/api/vendors/'+id).then(r=>r.json());
  if(j.error){ paint(my, `<div class="err">${esc(j.error)}</div>`); return; }
  const v=j.vendor;
  window.__menu=v.menu; window.__vendor=v;
  if(cartVendorId!==v.id){ for(const k of Object.keys(cart)) delete cart[k]; cartVendorId=v.id; }
  const img=v.primary_image_url||FALLBACK_IMG;
  const addrParts=[v.address,v.area,v.city,'Pakistan'].filter(Boolean);
  const mapParts=addrParts.filter((part,i)=>!addrParts.some((other,j)=>j!==i && other.toLowerCase().includes(part.toLowerCase()) && other.length>part.length));
  const mapQ=encodeURIComponent(mapParts.join(', '));
  const mapSrc='https://maps.google.com/maps?q='+mapQ+'&output=embed';
  const steps=[
    {label:'Listed', done:!!v.created_at},
    {label:'Approved', done:!!v.approved_at},
    {label:'Subscribed', done:!!v.subscription_plan},
    {label:'Delivery', done:!!v.delivery_enabled},
    {label:'Open now', done:!!v.open_now},
  ];
  const fmt=d=>d?String(d).slice(0,10):'—';
  const pktDay=new Date(Date.now()+5*3600*1000).getUTCDay();
  paint(my, `
  <div class="map-wrap">
    <iframe src="${mapSrc}" title="Map — ${esc(v.name)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
    <div class="map-overlay">
      <button class="map-back" type="button" onclick="location.hash='#/'" aria-label="Back">←</button>
      <span class="map-pill">${esc(v.name)}</span>
      <span class="map-live"><span class="live-dot"></span>${v.open_now?('Open now'+(v.closes_at?(' · closes '+esc(v.closes_at)):'')):'Closed'+(v.opens_at?(' · opens '+esc(v.opens_at)):'' )}</span>
    </div>
  </div>
  <div class="sheet-card">
    <div class="sheet-head">
      ${imgTag(img,'',v.name)}
      <div><h1>${esc(v.name)}</h1>
      <p class="muted" style="margin:4px 0 0">${stars(v.ratings.overall)} · ${v.ratings.count} reviews · ${esc(v.category)} · ${esc(v.city)}</p></div>
      <button class="heart-btn${savedIds.has(v.id)?' saved':''}" type="button" onclick="toggleSave(${v.id}, event)" title="Save this place" aria-label="Save" style="margin-left:auto">${savedIds.has(v.id)?'♥':'♡'}</button>
    </div>
    <p style="margin:14px 0 4px">${esc(v.description||'')}</p>
    <p class="muted">${esc(v.address||'')} ${v.area?('· '+esc(v.area)):''}</p>
    <p>${v.halal_verified?'<span class="badge halal">✓ 100% Halal verified</span>':v.halal_declared?'<span class="badge">Halal — as listed by the restaurant</span>':''} ${v.certificates&&v.certificates.length?v.certificates.map(c=>`<span class="badge halal">✓ ${esc(c.cert_type)} verified</span>`).join(' '):''}</p>
    <p class="muted">Accepts: ${esc(v.payment_methods||'Cash on Delivery')}</p>
    <div class="rider-actions">
      <a class="msg" href="#/contact">✉ Contact Zaiqa</a>
      ${v.delivery_phone?`<a class="call" href="tel:${esc(v.delivery_phone.replace(/[\s-]/g,''))}">☎ ${esc(v.delivery_phone)}</a>`:`<a class="msg" href="#/contact">No phone listed</a>`}
    </div>
    <div class="progress">${steps.map(s=>`<div class="step${s.done?' done':''}">${esc(s.label)}</div>`).join('')}</div>
    <ul class="timeline">
      <li><b>Listed on Zaiqa</b><span>${fmt(v.created_at)}</span></li>
      <li><b>Approved by Portal Admin</b><span>${fmt(v.approved_at)}</span></li>
      <li><b>Subscription: ${esc(v.subscription_plan||'No plan yet')}</b><span>${v.subscription_expires_at?('Valid until '+fmt(v.subscription_expires_at)):'Pay from the manager panel to stay listed'}</span></li>
      <li><b>Delivery</b><span>${v.delivery_enabled?('PKR '+v.delivery_fee_pkr+' fee · min order PKR '+v.min_order_pkr+(v.delivery_time?(' · '+esc(v.delivery_time)):'')):'No delivery — dine-in / takeaway only.'}</span></li>
    </ul>
    <p>${v.google_maps_url?`<a class="btn" href="${esc(v.google_maps_url)}" target="_blank" rel="noopener">📍 Open in Google Maps</a>`:''}
    <button class="small ghost" onclick="reportListing(${v.id},'wrong_info',null)">Report wrong info</button>
    <button class="small ghost" onclick="reportListing(${v.id},'closed',null)">Report closed</button>
    <button class="small ghost" onclick="shareVendor(${v.id})">Share</button></p>
  </div>
  <div class="panel"><h3>Opening hours</h3>
  ${v.hours && v.hours.length?`<table class="hours-table">${v.hours.map(h=>`<tr${h.day===pktDay?' class="today"':''}><td>${DAY_NAMES[h.day]}</td><td>${h.closed?'Closed':esc(h.open)+' – '+esc(h.close)}</td></tr>`).join('')}</table>`:'<p class="muted">Opening hours not set yet.</p>'}
  <p>${v.open_now?`<span style="color:var(--green-dark);font-weight:800">● Open now${v.closes_at?(' · closes '+esc(v.closes_at)):''}</span>`:`<span class="muted">Currently closed${v.opens_at?(' · opens '+esc(v.opens_at)):''}</span>`}</p></div>
  <div class="cards">
    <div class="card"><div class="num">${v.ratings.overall??'—'}</div><div class="lbl">Overall (${v.ratings.count} reviews)</div></div>
    <div class="card"><div class="num">${v.ratings.food??'—'}</div><div class="lbl">Food</div></div>
    <div class="card"><div class="num">${v.ratings.hygiene??'—'}</div><div class="lbl">Hygiene</div></div>
    <div class="card"><div class="num">${v.ratings.value??'—'}</div><div class="lbl">Value</div></div>
    ${v.delivery_enabled?`<div class="card"><div class="num">${v.ratings.delivery??'—'}</div><div class="lbl">Delivery</div></div>`:''}
  </div>
  <div class="panel"><h3>Your order — Menu (PKR)</h3>
  <p class="muted">${v.menu_last_updated?('Menu last updated '+esc(String(v.menu_last_updated).slice(0,10))):'Menu prices as listed by the restaurant.'} · Pay ${esc(v.payment_methods||'Cash on Delivery')} · Pick dishes, then order on WhatsApp — no commission, direct to the restaurant.</p>
  ${v.menu.length?v.menu.map(m=>`<div class="menu-item"><span><b>${esc(m.name)}</b><br><span class="muted">${esc(m.description||'')}</span></span><span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="price">PKR ${m.price_pkr}</span> ${m.available?`<span class="qty"><button class="qty-btn" type="button" onclick="cartAdd(${m.id},-1)">−</button><b id="qty-${m.id}">${cart[m.id]||0}</b><button class="qty-btn" type="button" onclick="cartAdd(${m.id},1)">+</button></span>`:'<span class="muted">unavailable</span>'} <button class="small ghost" onclick="reportListing(${v.id},'wrong_price',${m.id})">Price wrong?</button></span></div>`).join(''):'<p class="muted">Menu coming soon.</p>'}</div>
  <div class="cart-bar" id="cartBar" hidden></div>
  <div class="panel"><h3>Gallery</h3>${v.gallery.length?`<div class="gallery-row">${v.gallery.map(g=>`<img src="${esc(g.url)}" alt="" onerror="this.onerror=null;this.src='${FALLBACK_IMG}'">`).join('')}</div>`:'<p class="muted">No gallery photos yet.</p>'}</div>
  <div class="panel"><h3>Reviews</h3>${v.reviews.length?v.reviews.map(r=>`<div style="border-bottom:1px solid var(--line);padding:10px 0"><b>${esc(r.customer_name)}</b> · ${stars(r.overall)} <span class="muted">${r.status==='flagged'?'(flagged for moderation)':''}</span><p>${esc(r.comment)}</p>${r.photo_url?`<p><img src="${esc(r.photo_url)}" alt="Review photo" style="max-width:220px;border-radius:12px" onerror="this.style.display='none'"></p>`:''}${r.admin_reply?`<p class="muted">↩ Admin reply: ${esc(r.admin_reply)}</p>`:''}<button class="small ghost" onclick="flagReview(${r.id})">🚩 Flag this review</button></div>`).join(''):'<p class="muted">No reviews yet — be the first.</p>'}
  <h4>Write a review (customers only, one per vendor)</h4>
  <form onsubmit="postReview(event,${v.id},${v.delivery_enabled?1:0})">
    <div class="row"><div><label>Food (1-5)</label><input name="food" type="number" min="1" max="5" required></div>
    <div><label>Hygiene (1-5)</label><input name="hygiene" type="number" min="1" max="5" required></div>
    <div><label>Value (1-5)</label><input name="value" type="number" min="1" max="5" required></div>
    <div><label>Overall (1-5)</label><input name="overall" type="number" min="1" max="5" required></div>
    ${v.delivery_enabled?'<div><label>Delivery (1-5)</label><input name="delivery" type="number" min="1" max="5"></div>':''}</div>
    <label>Comment (10+ characters)</label><textarea name="comment" rows="3" required></textarea>
    <label>Photo (optional — image URL of the dish or place)</label><input name="photo_url" placeholder="https://…">
    <button class="btn" style="margin-top:10px">Submit review</button><span id="revMsg" class="muted"></span></form></div>`);
  renderCartBar();
}

window.flagReview=async(id)=>{ try{ await api('POST','/api/reviews/'+id+'/flag',{reason:'Flagged by visitor'}); alert('Review flagged for moderation.'); render(); }catch(e){ alert(e.message); } };
window.postReview=async(e,id,delEnabled)=>{ e.preventDefault(); const f=e.target;
  const body={vendor_id:id, food:+f.food.value, hygiene:+f.hygiene.value, value:+f.value.value, overall:+f.overall.value, comment:f.comment.value};
  if(f.photo_url.value) body.photo_url=f.photo_url.value;
  if(delEnabled && f.delivery.value) body.delivery=+f.delivery.value;
  try{ const j=await api('POST','/api/reviews',body); document.getElementById('revMsg').textContent=' ✓ Review saved ('+j.status+').'; renderVendor(id); }
  catch(err){ document.getElementById('revMsg').textContent=' ✗ '+err.message; } };
async function fileToBase64(file){
  if(!file) return null;
  const buf = await file.arrayBuffer();
  let bin=''; const bytes=new Uint8Array(buf);
  for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function renderOffers(my){ my = my ?? ++renderSeq;
  // Plans are for restaurant managers only — customers and visitors
  // never see prices here.
  if(!me || me.role!=='manager'){ paint(my, `<h1>Plans for restaurants</h1><p>Plans are only for restaurant managers. Please <a href="#/login">log in</a> as a manager to see them.</p><p><a class="btn" href="#/manager">Go to Manager Panel</a></p>`); return; }
  const plansJ=await fetch('/api/plans').then(r=>r.json()).catch(()=>null);
  const plans = plansJ&&plansJ.plans ? plansJ.plans : {Basic:{days:30,price:1500},Premium:{days:90,price:4500},Featured:{days:90,price:9000}};
  const methods = plansJ&&plansJ.methods ? plansJ.methods : ['Bank Transfer','Easypaisa','JazzCash','Sadapay','Nayapay','Manual Reference'];
  const dealTaglines={Basic:'LIST YOUR PLACE, START SMALL',Premium:'STAND OUT FOR 90 DAYS',Featured:'TOP SPOT IN THE DIRECTORY'};
  paint(my, `<h1>Plans for restaurants</h1>
  <p class="muted">A vendor stays public only while its subscription is current. Pay from the manager panel — the Portal Admin approves the payment, then the subscription extends.</p>
  <div class="deals-row">${Object.entries(plans).map(([n,p])=>dealCard(n,p.price,p.days,dealTaglines[n]||n)).join('')}</div>
  <div class="panel"><h3>How it works</h3>
  <ul class="timeline">
    <li><b>1 · Ask the Portal Admin to create your manager account</b><span>You get a setup code by email — activate it on the Register page, then submit your one vendor listing.</span></li>
    <li><b>2 · Pay for a plan</b><span>${esc(methods.join(' · '))} — attach the payment proof (PNG/JPEG/PDF, under 5 MB).</span></li>
    <li><b>3 · Admin approves</b><span>Your subscription extends by the plan days and your listing goes public.</span></li>
  </ul><p><a class="btn" href="#/manager">Go to Manager Panel</a></p></div>`);
}
function renderAccount(){
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> first to change your password.</p>'; return; }
  app.innerHTML=`<h1>Account — Change password</h1><div class="panel"><p class="muted">Logged in as ${esc(me.name)} (${esc(me.role)}). Changing your password keeps this session and signs out your other sessions.</p>
  <form onsubmit="doChangePassword(event)"><label>Old password</label><input name="old_password" type="password" required>
  <label>New password (8+ characters)</label><input name="new_password" type="password" required>
  <button class="btn" style="margin-top:10px">Change password</button><span id="cpMsg" class="muted"></span></form>
  <p style="margin-top:16px"><button class="small ghost" onclick="logout()">Log out</button></p></div>`;
}
window.doChangePassword=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/change-password',{old_password:f.old_password.value,new_password:f.new_password.value}); document.getElementById('cpMsg').textContent=' ✓ '+j.message; f.reset(); }
  catch(err){ document.getElementById('cpMsg').textContent=' ✗ '+err.message; } };
function renderStatic(title, html){ app.innerHTML=`<h1>${title}</h1><div class="panel">${html}</div>`; }
function renderContact(){
  app.innerHTML=`<h1>Contact Zaiqa</h1><div class="panel"><form onsubmit="sendContact(event)">
  <label>Name</label><input name="name" required><label>Email</label><input name="email" type="email" required>
  <label>Subject</label><input name="subject" required><label>Message (10+ characters)</label><textarea name="message" rows="4" required></textarea>
  <button class="btn" style="margin-top:10px">Send message</button><span id="cMsg" class="muted"></span></form></div>`;
}
window.sendContact=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/contact',{name:f.name.value,email:f.email.value,subject:f.subject.value,message:f.message.value}); document.getElementById('cMsg').textContent=' ✓ '+j.message; f.reset(); }
  catch(err){ document.getElementById('cMsg').textContent=' ✗ '+err.message; } };
function renderLogin(){
  app.innerHTML=`<h1>Log in</h1><div class="panel"><form onsubmit="doLogin(event)">
  <label>Email or phone</label><input name="identifier" required placeholder="you@example.com">
  <label>Password</label><input name="password" type="password" required>
  <button class="btn" style="margin-top:10px">Log in</button><span id="lMsg" class="muted"></span></form>
  <div id="otpBox"></div><p class="muted">After your password, we email a login code to your Gmail — enter it to reach your dashboard. (The code is only shown on screen when the app runs on a PC with no email connected.)</p>
  <p class="muted">No account yet? <a href="#/register">Register here</a>.</p></div>`;
}
window.doLogin=async(e)=>{ e.preventDefault(); const f=e.target;
  document.getElementById('otpBox').innerHTML=''; // never leave a stale code box from an earlier attempt
  document.getElementById('lMsg').textContent='';
  try{ const j=await api('POST','/api/auth/login',{identifier:f.identifier.value,password:f.password.value});
    if(j.otp_required){
      const note = j.channel==='email'
        ? 'A login code was emailed to your Gmail — check your inbox (and spam).'
        : (j.dev_code ? 'Login code (development only): <b>'+esc(j.dev_code)+'</b>' : 'A login code was sent.');
      document.getElementById('otpBox').innerHTML=`<div class="ok">${note}</div>
      <form onsubmit="doLoginVerify(event,'${j.login_token}')"><label>Login code (6 digits)</label><input name="code" required><button class="btn" style="margin-top:10px">Verify &amp; log in</button></form>
      <p class="muted"><a href="#" onclick="doLoginResend('${j.login_token}');return false">Code did not arrive? Send a new one</a></p>`;
      return;
    }
    document.getElementById('lMsg').textContent=' ✓ Logged in as '+j.user.role; location.hash = j.user.role==='owner' ? '#/admin' : j.user.role==='manager' ? '#/manager' : '#/';
  }catch(err){ document.getElementById('lMsg').textContent=' ✗ '+err.message; } };
window.doLoginResend=async(token)=>{
  try{ const j=await api('POST','/api/auth/login-resend',{login_token:token});
    const note = j.channel==='email' ? 'A new login code was emailed to you.' : (j.dev_code ? 'New login code (development only): <b>'+esc(j.dev_code)+'</b>' : 'A new login code was sent.');
    const box=document.getElementById('otpBox');
    if(box){ const okEl=box.querySelector('.ok'); if(okEl) okEl.innerHTML=note; }
    alert(note.replace(/<[^>]+>/g,''));
  }catch(err){ alert(err.message); }
};
window.doLoginVerify=async(e,token)=>{ e.preventDefault();
  try{ const j=await api('POST','/api/auth/login-verify',{login_token:token,code:e.target.code.value});
    location.hash = j.user.role==='owner' ? '#/admin' : j.user.role==='manager' ? '#/manager' : j.user.role==='staff' ? '#/manager' : '#/';
  }catch(err){ alert(err.message); } };
function renderRegister(){
  app.innerHTML=`<h1>Register</h1>
  <div class="panel"><h3>Customer — exactly one contact channel</h3><form onsubmit="doRegCustomer(event)">
  <label>Name</label><input name="name" required>
  <label><input type="radio" name="ctype" value="email" checked style="width:auto"> Email</label>
  <label><input type="radio" name="ctype" value="phone" style="width:auto"> Phone (not available yet — use your Gmail)</label>
  <label>Email (if email chosen)</label><input name="email" type="email">
  <label>Phone (if phone chosen, e.g. 03001234567)</label><input name="phone">
  <label>Password (8+ characters)</label><input name="password" type="password" required>
  <button class="btn" style="margin-top:10px">Register as customer</button><span id="rcMsg" class="muted"></span></form><div id="rcCode"></div></div>
  <div class="panel"><h3>Manager — your account is created by the Portal Admin</h3><p class="muted">Managers cannot register themselves. Ask the Portal Admin to create your manager account — a setup code will be emailed to your Gmail. Then activate it here.</p>
  <form onsubmit="doManagerSetup(event)">
  <label>Email (the one the admin used)</label><input name="email" type="email" required>
  <label>Setup code (6 digits, from the email)</label><input name="code" required>
  <label>Your new password (8+ characters)</label><input name="password" type="password" required>
  <button class="btn" style="margin-top:10px">Activate manager account</button><span id="msMsg" class="muted"></span></form></div>
  <div class="panel"><h3>Verify your account</h3><form onsubmit="doVerify(event)">
  <label>Email or phone used at registration</label><input name="identifier" required>
  <label>6-digit code</label><input name="code" required>
  <button class="btn" style="margin-top:10px">Verify</button><span id="vMsg" class="muted"></span></form>
  <p class="muted">Didn't get the code? <a href="#" onclick="doRequestCode();return false">Send a new one</a></p></div>`;
}
window.doRegCustomer=async(e)=>{ e.preventDefault(); const f=e.target; const ct=f.ctype.value;
  const body={name:f.name.value,password:f.password.value}; if(ct==='email') body.email=f.email.value; else body.phone=f.phone.value;
  try{ const j=await api('POST','/api/auth/register-customer',body);
    const note = j.channel==='email'
      ? 'Account created. We emailed your verification code — enter it in the verify form below.'
      : 'Account created. Development verification code: <b>'+esc(j.dev_code||'—')+'</b> — enter it in the verify form below.';
    document.getElementById('rcCode').innerHTML=`<div class="ok">${note}</div>`;
  }
  catch(err){ document.getElementById('rcMsg').textContent=' ✗ '+err.message; } };
window.doManagerSetup=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/manager-setup',{email:f.email.value,code:f.code.value,password:f.password.value});
    document.getElementById('msMsg').textContent=' ✓ '+j.message; f.reset();
  }
  catch(err){ document.getElementById('msMsg').textContent=' ✗ '+err.message; } };
window.doRequestCode=async()=>{
  const vals=await openFormModal('Send a new verification code', [
    {key:'identifier', label:'Email or phone used at registration', type:'text', required:true, placeholder:'you@example.com'},
  ], 'Send new code');
  if(!vals) return;
  try{ const j=await api('POST','/api/auth/request-code',{identifier:vals.identifier});
    alert(j.channel==='email' ? 'A new verification code was emailed to you.' : (j.dev_code ? 'New code (development only): '+j.dev_code : 'A new code was sent.'));
  }catch(err){ alert(err.message); }
};
window.doVerify=async(e)=>{ e.preventDefault(); const f=e.target;
  try{ const j=await api('POST','/api/auth/verify',{identifier:f.identifier.value,code:f.code.value}); document.getElementById('vMsg').textContent=' ✓ '+j.message; }
  catch(err){ document.getElementById('vMsg').textContent=' ✗ '+err.message; } };
async function renderManager(my){ my = my ?? ++renderSeq;
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> as a manager first.</p>'; return; }
  if(me.role==='staff'){
    const j=await api('GET','/api/staff/vendor').catch(e=>({error:e.message}));
    if(j.error){ paint(my, `<div class="err">${esc(j.error)}</div>`); return; }
    paint(my, `<h1>Staff Panel — ${esc(j.vendor.name)}</h1><p class="muted">You can manage menu and availability for your assigned vendor only.</p>
    <div class="panel"><h3>Menu</h3>${j.menu.map(m=>`<div class="menu-item"><span>${esc(m.name)} — PKR ${m.price_pkr}</span><span>${m.available?'Available':'Unavailable'} <button class="small" onclick="staffToggle(${m.id},${m.available?0:1})">Toggle availability</button> <button class="small danger" onclick="staffDelete(${m.id})">Delete</button></span></div>`).join('')}</div>`);
    window.staffToggle=async(id,avail)=>{ await api('PATCH','/api/staff/menu/'+id,{available:!!avail}); renderManager(); };
    window.staffDelete=async(id)=>{ const vals=await openFormModal('Delete this dish from the menu?', [], 'Delete'); if(!vals) return; await api('DELETE','/api/staff/menu/'+id); renderManager(); };
    return;
  }
  if(me.role!=='manager'){ paint(my, '<p>This panel is for managers. Admins use <a href="#/admin">Admin Panel</a>.</p>'); return; }
  const j=await api('GET','/api/manager/vendor');
  if(!j.vendor){
    paint(my, `<h1>Manager Panel</h1><p class="muted">No vendor assigned to your account yet. You can submit your own below, or ask the Portal Admin to assign an existing listing to your email.</p><div class="panel"><h3>Submit your vendor (one only)</h3><form onsubmit="submitVendor(event)">
    <label>Business name</label><input name="name" required>
    <div class="row"><div><label>Category</label><select name="category"><option>Desi</option><option>BBQ</option><option>Karahi</option><option>Fast Food</option><option>Sweets</option><option>Chinese</option><option>Bakery</option><option>Beverages</option></select></div>
    <div><label>City</label><input name="city" required></div></div>
    <label>Area</label><input name="area"><label>Address</label><input name="address">
    <label>Description</label><textarea name="description" rows="3"></textarea>
    <label>Delivery phone</label><input name="delivery_phone"><label>Google Maps URL</label><input name="google_maps_url">
    <label>Primary image URL</label><input name="primary_image_url">
    <div class="row"><div><label><input type="checkbox" name="delivery_enabled" style="width:auto"> Delivery enabled</label></div>
    <div><label>Delivery fee (PKR)</label><input name="delivery_fee_pkr" type="number" value="0"></div>
    <div><label>Min order (PKR)</label><input name="min_order_pkr" type="number" value="0"></div></div>
    <button class="btn" style="margin-top:10px">Submit for review</button><span id="svMsg" class="muted"></span></form></div>`);
    window.submitVendor=async(e)=>{ e.preventDefault(); const f=e.target;
      const body={name:f.name.value,category:f.category.value,city:f.city.value,area:f.area.value,address:f.address.value,description:f.description.value,delivery_phone:f.delivery_phone.value,google_maps_url:f.google_maps_url.value,primary_image_url:f.primary_image_url.value,delivery_enabled:f.delivery_enabled.checked,delivery_fee_pkr:+f.delivery_fee_pkr.value,min_order_pkr:+f.min_order_pkr.value};
      try{ await api('POST','/api/manager/vendors',body); renderManager(); }catch(err){ document.getElementById('svMsg').textContent=' ✗ '+err.message; } };
    return;
  }
  const v=j.vendor;
  const plansJ=await fetch('/api/plans').then(r=>r.json()).catch(()=>null);
  const planLine=plansJ&&plansJ.plans
    ? Object.entries(plansJ.plans).map(([n,p])=>`${n} ${p.days} days PKR ${p.price.toLocaleString()}`).join(' · ')
    : 'Basic 30 days PKR 1,500 · Premium 90 days PKR 4,500 · Featured 90 days PKR 9,000';
  const catOpts=['Desi','BBQ','Karahi','Fast Food','Sweets','Chinese','Bakery','Beverages']
    .map(c=>`<option${c===v.category?' selected':''}>${c}</option>`).join('');
  paint(my, `<h1>Manager Panel — ${esc(v.name)}</h1>
  <p><span class="badge plan">${esc(v.status)}</span> <span class="badge">${esc(v.subscription_plan||'No plan yet')}</span> ${v.subscription_expires_at?`<span class="badge">Subscription until ${esc(v.subscription_expires_at.slice(0,10))}</span>`:''}</p>
  <div class="cards"><div class="card"><div class="num">${v.menu.length}</div><div class="lbl">Menu items</div></div><div class="card"><div class="num">${v.reviews.length}</div><div class="lbl">Reviews</div></div><div class="card"><div class="num">${v.payments.filter(p=>p.status==='approved').reduce((a,p)=>a+p.amount_pkr,0).toLocaleString()}</div><div class="lbl">PKR approved payments</div></div></div>
  <div class="panel"><h3>Edit details</h3><p class="muted">Description, area, address, city, category, open/closed and delivery settings change here instantly. Name, maps link, delivery phone, images and slug need an admin-approved update request below.</p>
  <form onsubmit="editDetails(event,${v.id})">
    <div class="row"><div><label>Category</label><select name="category">${catOpts}</select></div>
    <div><label>City</label><input name="city" value="${esc(v.city)}" required></div></div>
    <label>Area</label><input name="area" value="${esc(v.area||'')}">
    <label>Address</label><input name="address" value="${esc(v.address||'')}">
    <label>Description</label><textarea name="description" rows="3">${esc(v.description||'')}</textarea>
    <div class="row"><div><label><input type="checkbox" name="open" style="width:auto"${v.open?' checked':''}> Open now</label></div>
    <div><label><input type="checkbox" name="delivery_enabled" style="width:auto"${v.delivery_enabled?' checked':''}> Delivery enabled</label></div>
    <div><label>Delivery fee (PKR)</label><input name="delivery_fee_pkr" type="number" min="0" value="${v.delivery_fee_pkr||0}"></div>
    <div><label>Min order (PKR)</label><input name="min_order_pkr" type="number" min="0" value="${v.min_order_pkr||0}"></div></div>
    <label>Delivery time (e.g. 30-45 min)</label><input name="delivery_time" value="${esc(v.delivery_time||'')}">
    <label><input type="checkbox" name="halal_declared" style="width:auto"${v.halal_declared?' checked':''}> Our food is 100% Halal (shown on your page; the admin verifies it)</label>
    <label>Payment methods you accept</label>
    <div>${['Cash on Delivery','JazzCash','Easypaisa','Bank Transfer'].map(m=>`<label style="display:inline-block;margin-right:14px"><input type="checkbox" name="pay_${m}" style="width:auto"${(v.payment_methods||'').includes(m)?' checked':''}> ${m}</label>`).join('')}</div>
    <button class="btn" style="margin-top:10px">Save details</button><span id="edMsg" class="muted"></span></form>
    ${v.status==='approved'?'<p class="muted">Note: saving details on an approved listing moves it to “pending update” until the admin re-approves it — it stays visible meanwhile.</p>':''}</div>
  <div class="panel"><h3>Opening hours</h3><p class="muted">The page shows a live "Open now" badge from these hours (Pakistan time). Tick a day as closed when the kitchen is shut.</p>
  <form onsubmit="saveHours(event,${v.id})">
  ${[0,1,2,3,4,5,6].map(d=>{ const h=(v.hours||[]).find(x=>x.day===d); return `<div class="hours-row"><b style="width:90px">${DAY_NAMES[d]}</b>
  <label style="display:inline"><input type="checkbox" name="closed_${d}" style="width:auto"${h&&h.closed?' checked':''}> Closed</label>
  <input name="open_${d}" type="time" value="${h&&h.open?esc(h.open):'11:00'}" style="width:120px">
  <input name="close_${d}" type="time" value="${h&&h.close?esc(h.close):'23:00'}" style="width:120px"></div>`; }).join('')}
  <button class="btn" style="margin-top:10px">Save hours</button><span id="hoursMsg" class="muted"></span></form></div>
  <div class="panel"><h3>Subscription payment</h3><form onsubmit="payPlan(event,${v.id})">
    <div class="row"><div><label>Plan</label><select name="plan">${plansJ&&plansJ.plans?Object.keys(plansJ.plans).map(n=>`<option>${esc(n)}</option>`).join(''):'<option>Basic</option><option>Premium</option><option>Featured</option>'}</select></div>
    <div><label>Method</label><select name="method"><option>Bank Transfer</option><option>Easypaisa</option><option>JazzCash</option><option>Sadapay</option><option>Nayapay</option><option>Manual Reference</option></select></div>
    <div><label>Reference / transaction ID</label><input name="reference_text" required></div></div>
    <label>Payment proof file (PNG/JPEG/PDF, under 5 MB, optional)</label><input name="proof_file" type="file" accept=".png,.jpg,.jpeg,.pdf">
    <p class="muted">${esc(planLine)}. Proof is checked by MIME type and file signature on the server.</p>
    <button class="btn">Submit payment</button><span id="payMsg" class="muted"></span></form>
    <h4>Payments</h4>${v.payments.map(p=>`<p>${esc(p.plan)} — PKR ${p.amount_pkr} — ${esc(p.method)} — ${esc(p.status)}</p>`).join('')||'<p class="muted">No payments yet.</p>'}</div>
  <div class="panel"><h3>Sensitive-field update request</h3><p class="muted">Name, Google Maps URL, delivery phone, image URLs and slug can only change after admin approval.</p>
  <form onsubmit="updateReq(event,${v.id})"><label>New business name (optional)</label><input name="name"><label>New Google Maps URL (optional)</label><input name="google_maps_url"><button class="btn" style="margin-top:10px">Request update</button><span id="urMsg" class="muted"></span></form>
  <h4>Update requests</h4>${v.update_requests.map(r=>`<p>#${r.id} — ${esc(r.status)} — ${esc(r.fields_json)}</p>`).join('')||'<p class="muted">None yet.</p>'}</div>
  <div class="panel"><h3>Add menu item</h3><form onsubmit="addMenu(event)"><div class="row"><div><label>Name</label><input name="name" required></div><div><label>Price (PKR)</label><input name="price_pkr" type="number" required></div></div><button class="btn" style="margin-top:10px">Add item</button></form>
  <h4>Menu</h4>${v.menu.map(m=>`<div class="menu-item"><span>${esc(m.name)} — PKR ${m.price_pkr}</span><span>${m.available?'Available':'Unavailable'} <button class="small" onclick="mgrToggle(${m.id},${m.available?0:1})">Toggle</button> <button class="small danger" onclick="mgrDelete(${m.id})">Delete</button></span></div>`).join('')}</div>
  <div class="panel"><h3>Certificates</h3><form onsubmit="addCert(event,${v.id})"><label>Certificate type</label><input name="cert_type" required placeholder="e.g. Food Licence"><label>Certificate file (PNG/JPEG/PDF, under 5 MB, optional)</label><input name="cert_file" type="file" accept=".png,.jpg,.jpeg,.pdf"><button class="btn" style="margin-top:10px">Submit certificate</button><span id="certMsg" class="muted"></span></form>
  ${v.certificates.map(c=>`<p>${esc(c.cert_type)} — ${esc(c.status)}</p>`).join('')||'<p class="muted">No certificates yet.</p>'}</div>
  <div class="panel"><h3>Gallery photo (needs admin approval before it shows publicly)</h3><form onsubmit="addGallery(event)"><label>Image URL</label><input name="url" required placeholder="https://…"><label>Caption</label><input name="caption"><button class="btn" style="margin-top:10px">Submit gallery photo</button><span id="galMsg" class="muted"></span></form>
  <h4>Gallery</h4>${v.gallery.map(g=>`<p>${esc(g.url.slice(0,60))} — ${esc(g.status)}</p>`).join('')||'<p class="muted">No gallery photos yet.</p>'}</div>
  <div class="panel"><h3>Reports about your listing</h3>${v.reports && v.reports.length ? v.reports.map(r=>`<p>#${r.id} — ${esc(r.type)} — ${esc(r.status)} — ${esc(r.message)}</p>`).join('') : '<p class="muted">No reports. Visitors can report a wrong phone, a closed shop, a moved location or a wrong price — those land here and with the admin.</p>'}</div>
  <div class="panel"><h3>Add staff (menu/availability only, for this vendor)</h3><form onsubmit="addStaff(event)"><label>Staff name</label><input name="name" required><label>Staff email</label><input name="email" type="email" required><label>Staff password (8+ characters)</label><input name="password" type="password" required><button class="btn" style="margin-top:10px">Add staff</button><span id="staffMsg" class="muted"></span></form>
  <p class="muted">Staff can only manage menu and availability for this vendor — never vendor details, payments or admin routes.</p></div>`);
  window.editDetails=async(e,id)=>{ e.preventDefault(); const f=e.target;
    try{ await api('PATCH','/api/manager/vendors/'+id,{category:f.category.value,city:f.city.value,area:f.area.value,address:f.address.value,description:f.description.value,open:f.open.checked,delivery_enabled:f.delivery_enabled.checked,delivery_fee_pkr:+f.delivery_fee_pkr.value,min_order_pkr:+f.min_order_pkr.value,delivery_time:f.delivery_time.value,halal_declared:f.halal_declared.checked,payment_methods:['Cash on Delivery','JazzCash','Easypaisa','Bank Transfer'].filter(m=>f['pay_'+m].checked).join(', ')||'Cash on Delivery'});
      document.getElementById('edMsg').textContent=' ✓ Details saved.'; renderManager(); }
    catch(err){ document.getElementById('edMsg').textContent=' ✗ '+err.message; } };
  window.payPlan=async(e,id)=>{ e.preventDefault(); const f=e.target;
    try{ const body={plan:f.plan.value,method:f.method.value,reference_text:f.reference_text.value,vendor_id:id};
      const file=f.proof_file.files[0];
      if(file){ body.proof_filename=file.name; body.proof_mimetype=file.type; body.proof_base64=await fileToBase64(file); }
      const j=await api('POST','/api/manager/payments',body); document.getElementById('payMsg').textContent=' ✓ Payment submitted (PKR '+j.amount_pkr+', pending admin approval).'; renderManager(); }
    catch(err){ document.getElementById('payMsg').textContent=' ✗ '+err.message; } };
  window.addGallery=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ await api('POST','/api/manager/gallery',{url:f.url.value,caption:f.caption.value}); renderManager(); }catch(err){ document.getElementById('galMsg').textContent=' ✗ '+err.message; } };
  window.addStaff=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ const j=await api('POST','/api/manager/staff',{name:f.name.value,email:f.email.value,password:f.password.value}); document.getElementById('staffMsg').textContent=' ✓ Staff added (id '+j.staffId+').'; f.reset(); }
    catch(err){ document.getElementById('staffMsg').textContent=' ✗ '+err.message; } };
  window.updateReq=async(e,id)=>{ e.preventDefault(); const f=e.target; const body={}; if(f.name.value) body.name=f.name.value; if(f.google_maps_url.value) body.google_maps_url=f.google_maps_url.value;
    try{ await api('POST','/api/manager/vendors/'+id+'/update-request',body); renderManager(); }catch(err){ document.getElementById('urMsg').textContent=' ✗ '+err.message; } };
  window.addMenu=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ await api('POST','/api/manager/menu',{name:f.name.value,price_pkr:+f.price_pkr.value}); renderManager(); }catch(err){ alert(err.message); } };
  window.mgrToggle=async(id,avail)=>{ await api('PATCH','/api/manager/menu/'+id,{available:!!avail}); renderManager(); };
  window.mgrDelete=async(id)=>{ const vals=await openFormModal('Delete this dish from the menu?', [], 'Delete'); if(!vals) return; await api('DELETE','/api/manager/menu/'+id); renderManager(); };
  window.addCert=async(e,id)=>{ e.preventDefault(); const f=e.target;
    try{ const body={cert_type:f.cert_type.value,vendor_id:id};
      const file=f.cert_file.files[0];
      if(file){ body.file_filename=file.name; body.file_mimetype=file.type; body.file_base64=await fileToBase64(file); }
      await api('POST','/api/manager/certificates',body); renderManager(); }catch(err){ document.getElementById('certMsg').textContent=' ✗ '+err.message; } };
  window.saveHours=async(e,id)=>{ e.preventDefault(); const f=e.target;
    const hours=[];
    for(let d=0; d<7; d++){ hours.push({day:d, closed:f['closed_'+d].checked, open:f['open_'+d].value, close:f['close_'+d].value}); }
    try{ await api('POST','/api/manager/vendors/'+id+'/hours',{hours}); document.getElementById('hoursMsg').textContent=' ✓ Hours saved.'; renderManager(); }
    catch(err){ document.getElementById('hoursMsg').textContent=' ✗ '+err.message; } };
}
async function renderAdmin(my){ my = my ?? ++renderSeq;
  if(!me){ app.innerHTML='<p>Please <a href="#/login">log in</a> as the Portal Admin first.</p>'; return; }
  if(me.role!=='owner'){ app.innerHTML='<div class="err">Admin panel is for the Portal Admin (owner) only. Your role: '+esc(me.role)+'</div>'; return; }
  const [rep, vendors, pays, reqs, reviews, auditLog, certs, gallery, users, contacts, activity, lreports, plans] = await Promise.all([
    api('GET','/api/admin/reports'), api('GET','/api/admin/vendors'), api('GET','/api/admin/payments'),
    api('GET','/api/admin/update-requests'), api('GET','/api/admin/reviews'), api('GET','/api/admin/audit-log'),
    api('GET','/api/admin/certificates'), api('GET','/api/admin/gallery'), api('GET','/api/admin/users'), api('GET','/api/admin/contacts'),
    api('GET','/api/admin/activity'), api('GET','/api/admin/listing-reports'), api('GET','/api/admin/plans'),
  ]).catch(e=>{ paint(my, `<div class="err">${esc(e.message)}</div>`); return []; });
  if(!rep) return;
  const t=rep.totals;
  paint(my, `<h1>Admin Dashboard — Zaiqa</h1><p class="muted">Portal Admin overview. All approvals, suspensions and emergency edits are audit-logged.</p>
  <div class="cards">
    <div class="card"><div class="num" data-count="${t.vendors_total}">0</div><div class="lbl">Vendors total</div></div>
    <div class="card"><div class="num" data-count="${t.vendors_approved}">0</div><div class="lbl">Approved</div></div>
    <div class="card"><div class="num" data-count="${t.vendors_pending}">0</div><div class="lbl">Pending</div></div>
    <div class="card"><div class="num" data-count="${t.reviews_active}">0</div><div class="lbl">Active reviews</div></div>
    <div class="card"><div class="num" data-count="${t.payments_approved_total_pkr}">0</div><div class="lbl">PKR approved payments</div></div>
  </div>
  <div class="panel"><h3>Recent activity — reviews per day (last 14 days)</h3><p>${activity.activity.map(a=>`${esc(a.d)}: ${a.n}`).join(' · ')||'No reviews yet.'}</p></div>
  <div class="panel"><h3>Top 5 by rating</h3><table><tr><th>Vendor</th><th>City</th><th>Avg</th><th>Reviews</th></tr>${rep.top_by_rating.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.city)}</td><td>${x.avg_overall}</td><td>${x.n}</td></tr>`).join('')||'<tr><td colspan="4">No rated vendors yet</td></tr>'}</table>
  <h3>Top 5 by review count</h3><table><tr><th>Vendor</th><th>City</th><th>Reviews</th><th>Avg</th></tr>${rep.top_by_review_count.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.city)}</td><td>${x.n}</td><td>${x.avg_overall}</td></tr>`).join('')||'<tr><td colspan="4">None yet</td></tr>'}</table>
  <h3>Category totals</h3><p>${rep.category_totals.map(c=>`${esc(c.category)}: ${c.n}`).join(' · ')}</p>
  <h3>Menus not updated for 60+ days</h3>${rep.stale_menus && rep.stale_menus.length ? rep.stale_menus.map(m=>`<p>${esc(m.name)} (${esc(m.city)}) — last update ${m.last_menu_update?esc(String(m.last_menu_update).slice(0,10)):'never'}</p>`).join('') : '<p class="muted">All menus are fresh.</p>'}
  <p>Listing reports pending: <b>${t.listing_reports_pending||0}</b></p></div>
  <div class="panel"><h3>Vendors — approve / reject / suspend / assign</h3><p class="muted">Unclaimed listings show "Unassigned" — assign each one to a registered manager by email. One vendor per manager; a manager only ever sees their own vendor.</p><table><tr><th>Name</th><th>City</th><th>Status</th><th>Plan</th><th>Manager</th><th>Actions</th></tr>${vendors.vendors.map(v=>`<tr><td>${esc(v.name)}</td><td>${esc(v.city)}</td><td>${esc(v.status)}</td><td>${esc(v.subscription_plan||'—')}</td><td>${v.manager_name?esc(v.manager_name)+' ('+esc(v.manager_email||'')+')':'Unassigned'}</td><td>
    <button class="small" onclick="adminAssign(${v.id})">Assign</button>
    ${v.manager_id?`<button class="small ghost" onclick="adminUnassign(${v.id})">Unassign</button>`:''}
    <button class="small" onclick="adminVendor(${v.id},'approve')">Approve</button>
    <button class="small ghost" onclick="adminVendorReason(${v.id},'reject')">Reject</button>
    <button class="small danger" onclick="adminVendorReason(${v.id},'suspend')">Suspend</button>
    <button class="small ghost" onclick="adminVendor(${v.id},'unsuspend')">Unsuspend</button>
    <button class="small" onclick="adminVerifyHalal(${v.id})">Verify halal</button>
    <button class="small ghost" onclick="adminEmergencyEdit(${v.id})">Emergency rename</button>
    <button class="small danger" onclick="adminEmergencyDelete(${v.id})">Emergency delete</button></td></tr>`).join('')}</table>
  <p class="muted">Emergency rename/delete both require a safety reason (5+ characters) and are audit-logged.</p></div>
  <div class="panel"><h3>Create a manager account</h3><p class="muted">Managers cannot register themselves. Create the account here — a setup code is emailed to their Gmail, and they activate it from the Register page with their own password. Then assign their vendor from the table above.</p>
  <form onsubmit="adminCreateManager(event)"><div class="row"><div><label>Manager name</label><input name="name" required></div><div><label>Manager email</label><input name="email" type="email" required></div></div>
  <button class="btn" style="margin-top:10px">Create manager</button><span id="cmMsg" class="muted"></span></form></div>
  <div class="panel"><h3>Subscription plans — published by you</h3><p class="muted">Only published plans appear on the manager-only Plans page and can be bought. Unpublishing a plan stops new sales; payments already submitted for it still work.</p>
  ${plans.plans.map(p=>`<p>#${p.id} <b>${esc(p.name)}</b> — ${p.days} days — PKR ${p.price_pkr} — ${p.published?'Published':'Unpublished'} <button class="small" onclick="adminPlanEdit(${p.id},${p.days},${p.price_pkr})">Edit</button> <button class="small" onclick="adminPlanToggle(${p.id},${p.published?0:1})">${p.published?'Unpublish':'Publish'}</button></p>`).join('')||'<p class="muted">No plans yet.</p>'}
  <form onsubmit="adminCreatePlan(event)"><div class="row"><div><label>New plan name</label><input name="name" required placeholder="e.g. Starter"></div><div><label>Days</label><input name="days" type="number" min="1" max="365" required value="30"></div><div><label>Price (PKR)</label><input name="price_pkr" type="number" min="0" required value="500"></div></div>
  <button class="btn" style="margin-top:10px">Add plan (published)</button><span id="planMsg" class="muted"></span></form></div>
  <div class="panel"><h3>Certificates</h3>${certs.certificates.map(c=>`<p>#${c.id} ${esc(c.manager_name)} — ${esc(c.cert_type)} — ${esc(c.status)} ${c.status==='pending'?`<button class="small" onclick="adminCert(${c.id},'approve')">Approve</button> <button class="small ghost" onclick="adminCert(${c.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">No certificates.</p>'}</div>
  <div class="panel"><h3>Gallery images (pending approval)</h3>${gallery.gallery.filter(g=>g.status==='pending').map(g=>`<p>#${g.id} ${esc(g.vendor_name)} — ${esc(g.url.slice(0,60))} <button class="small" onclick="adminGallery(${g.id},'approve')">Approve</button> <button class="small ghost" onclick="adminGallery(${g.id},'reject')">Reject</button></p>`).join('')||'<p class="muted">No pending gallery images.</p>'}</div>
  <div class="panel"><h3>Listing reports — wrong info / wrong prices</h3>${lreports.reports.map(r=>`<p>#${r.id} ${esc(r.vendor_name)} (${esc(r.vendor_city)}) — ${esc(r.type)} — ${esc(r.status)} — ${esc(r.message)} ${r.status==='pending'?`<button class="small" onclick="adminReport(${r.id},'resolve')">Resolve</button> <button class="small ghost" onclick="adminReport(${r.id},'dismiss')">Dismiss</button>`:''}</p>`).join('')||'<p class="muted">No reports.</p>'}</div>
  <div class="panel"><h3>Users — suspend / activate</h3>${users.users.map(u=>`<p>#${u.id} ${esc(u.name)} (${esc(u.email||u.phone||'')}) — ${esc(u.role)} — ${esc(u.status)} ${u.role!=='owner'?`<button class="small ghost" onclick="adminUser(${u.id},'suspend')">Suspend</button> <button class="small" onclick="adminUser(${u.id},'activate')">Activate</button>`:''}</p>`).join('')}</div>
  <div class="panel"><h3>Contact messages</h3>${contacts.contacts.slice(0,20).map(c=>`<p>${esc(c.name)} (${esc(c.email)}) — ${esc(c.subject)}: ${esc(c.message.slice(0,100))}</p>`).join('')||'<p class="muted">No contact messages.</p>'}</div>
  <div class="panel"><h3>Payments</h3>${pays.payments.map(p=>`<p>#${p.id} ${esc(p.manager_name)} — ${esc(p.plan)} PKR ${Number(p.amount_pkr).toLocaleString()} — ${esc(p.method)} — ${esc(p.status)} ${p.status==='pending'?`<button class="small" onclick="adminPay(${p.id},'approve')">Approve</button> <button class="small ghost" onclick="adminPay(${p.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">No payments.</p>'}</div>
  <div class="panel"><h3>Update requests</h3>${reqs.requests.map(r=>`<p>#${r.id} ${esc(r.vendor_name)} — ${esc(r.status)} — ${esc(r.fields_json)} ${r.status==='pending'?`<button class="small" onclick="adminUpd(${r.id},'approve')">Approve</button> <button class="small ghost" onclick="adminUpd(${r.id},'reject')">Reject</button>`:''}</p>`).join('')||'<p class="muted">None.</p>'}</div>
  <div class="panel"><h3>Reviews — moderation</h3>${reviews.reviews.slice(0,20).map(r=>`<p>#${r.id} ${esc(r.vendor_name)} — ${esc(r.customer_name)} — ${esc(r.status)} — ${esc(r.comment.slice(0,80))} <button class="small ghost" onclick="adminReviewNote(${r.id})">Add note</button> <button class="small ghost" onclick="adminReviewReply(${r.id})">Reply</button> <button class="small ghost" onclick="adminReview(${r.id},'delete')">Soft-delete</button> <button class="small" onclick="adminReview(${r.id},'restore')">Restore (admin only)</button></p>`).join('')||'<p class="muted">No reviews.</p>'}</div>
  <div class="panel"><h3>Audit log (latest)</h3>${auditLog.log.slice(0,30).map(a=>`<p class="muted">${esc(a.created_at)} — ${esc(a.action)} — ${esc(a.target_type||'')} #${a.target_id??''} ${a.reason?esc('· '+a.reason):''}</p>`).join('')}</div>`);
  animateCounters();
  window.adminVendor=async(id,act)=>{ await api('POST',`/api/admin/vendors/${id}/${act}`,{}); renderAdmin(); };
  window.adminVendorReason=async(id,act)=>{ const noun=act==='reject'?'rejection':act==='suspend'?'suspension':act; const vals=await openFormModal('Reason for '+noun, [{key:'reason', label:'Reason (required)', type:'textarea', required:true}], 'Send'); if(!vals) return; await api('POST',`/api/admin/vendors/${id}/${act}`,{reason:vals.reason}); renderAdmin(); };
  window.adminPay=async(id,act)=>{ const body={}; if(act==='reject'){ const vals=await openFormModal('Reject payment', [{key:'reason', label:'Rejection reason', type:'textarea', required:true}], 'Reject payment'); if(!vals) return; body.reason=vals.reason; } await api('POST',`/api/admin/payments/${id}/${act}`,body); renderAdmin(); };
  window.adminUpd=async(id,act)=>{ const body={}; if(act==='reject'){ const vals=await openFormModal('Reject update request', [{key:'reason', label:'Rejection reason', type:'textarea', required:true}], 'Reject request'); if(!vals) return; body.reason=vals.reason; } await api('POST',`/api/admin/update-requests/${id}/${act}`,body); renderAdmin(); };
  window.adminReview=async(id,act)=>{ await api('POST',`/api/admin/reviews/${id}/${act}`,{reason:'Moderated from admin panel'}); renderAdmin(); };
  window.adminCert=async(id,act)=>{ const body={}; if(act==='reject'){ const vals=await openFormModal('Reject certificate', [{key:'reason', label:'Rejection reason', type:'textarea', required:true}], 'Reject certificate'); if(!vals) return; body.reason=vals.reason; } await api('POST',`/api/admin/certificates/${id}/${act}`,body); renderAdmin(); };
  window.adminGallery=async(id,act)=>{ await api('POST',`/api/admin/gallery/${id}/${act}`,{}); renderAdmin(); };
  window.adminUser=async(id,act)=>{ await api('POST',`/api/admin/users/${id}/${act}`,{}); renderAdmin(); };
  window.adminReport=async(id,act)=>{ await api('POST',`/api/admin/listing-reports/${id}/${act}`,{}); renderAdmin(); };
  window.adminVerifyHalal=async(id)=>{ await api('POST',`/api/admin/vendors/${id}/verify-halal`,{}); renderAdmin(); };
  window.adminAssign=async(id)=>{ const vals=await openFormModal('Assign vendor to a manager', [{key:'manager_email', label:'Manager email (the manager must already be created from the panel above)', type:'text', required:true, placeholder:'manager@example.com'}], 'Assign'); if(!vals) return; try{ await api('POST',`/api/admin/vendors/${id}/assign`,{manager_email:vals.manager_email}); renderAdmin(); }catch(e){ alert(e.message); } };
  window.adminUnassign=async(id)=>{ const vals=await openFormModal('Unassign this vendor?', [], 'Unassign'); if(!vals) return; await api('POST',`/api/admin/vendors/${id}/unassign`,{}); renderAdmin(); };
  window.adminReviewNote=async(id)=>{ const vals=await openFormModal('Admin note for this review', [{key:'note', label:'Note', type:'textarea', required:true}], 'Add note'); if(!vals) return; await api('POST',`/api/admin/reviews/${id}/note`,{note:vals.note}); renderAdmin(); };
  window.adminReviewReply=async(id)=>{ const vals=await openFormModal('Admin reply to this review', [{key:'reply', label:'Reply', type:'textarea', required:true}], 'Send reply'); if(!vals) return; await api('POST',`/api/admin/reviews/${id}/reply`,{reply:vals.reply}); renderAdmin(); };
  window.adminEmergencyEdit=async(id)=>{ const vals=await openFormModal('Emergency rename', [{key:'reason', label:'Safety reason (5+ characters, required)', type:'textarea', required:true}, {key:'name', label:'New vendor name (leave blank to keep current)', type:'text'}], 'Save edit'); if(!vals) return; const fields={}; if(vals.name) fields.name=vals.name; if(!Object.keys(fields).length){ alert('No field entered — nothing changed.'); return; } await api('POST',`/api/admin/vendors/${id}/emergency-edit`,{reason:vals.reason,fields}); renderAdmin(); };
  window.adminEmergencyDelete=async(id)=>{ const vals=await openFormModal('Delete this vendor permanently?', [{key:'reason', label:'Safety reason (5+ characters, required)', type:'textarea', required:true}], 'Delete permanently'); if(!vals) return; await api('DELETE',`/api/admin/vendors/${id}`,{reason:vals.reason}); renderAdmin(); };
  window.adminCreateManager=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ const j=await api('POST','/api/admin/managers',{name:f.name.value,email:f.email.value});
      document.getElementById('cmMsg').textContent=' ✓ '+j.message; f.reset(); renderAdmin(); }
    catch(err){ document.getElementById('cmMsg').textContent=' ✗ '+err.message; } };
  window.adminCreatePlan=async(e)=>{ e.preventDefault(); const f=e.target;
    try{ await api('POST','/api/admin/plans',{name:f.name.value,days:+f.days.value,price_pkr:+f.price_pkr.value});
      document.getElementById('planMsg').textContent=' ✓ Plan added and published.'; f.reset(); renderAdmin(); }
    catch(err){ document.getElementById('planMsg').textContent=' ✗ '+err.message; } };
  window.adminPlanToggle=async(id,published)=>{ await api('PATCH','/api/admin/plans/'+id,{published:!!published}); renderAdmin(); };
  window.adminPlanEdit=async(id,days,price)=>{ const vals=await openFormModal('Edit plan', [{key:'days', label:'Days (1-365)', type:'text', value:String(days), required:true}, {key:'price_pkr', label:'Price in PKR', type:'text', value:String(price), required:true}], 'Save plan'); if(!vals) return;
    try{ await api('PATCH','/api/admin/plans/'+id,{days:+vals.days,price_pkr:+vals.price_pkr}); renderAdmin(); }
    catch(e){ alert(e.message); } };
}
window.addEventListener('hashchange', render);
render();
