const types = [['overall','总榜'],['live','直播榜'],['video','短视频榜'],['prod_card','商品卡'],['content','达人榜'],['new','新品榜']];
const state = { type: 'overall', page: 1, pages: 1 };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatRange = (min, max) => min && max && min !== max ? `${min} - ${max}` : (min || max || '-');

function renderTabs() {
  $('tabs').innerHTML = types.map(([id,label]) => `<button class="${state.type===id?'active':''}" data-type="${id}">${label}</button>`).join('');
  document.querySelectorAll('[data-type]').forEach(button => button.onclick = () => { state.type=button.dataset.type; state.page=1; renderTabs(); load(); });
}

async function load() {
  const query = new URLSearchParams({ type: state.type, page: state.page, pageSize: 20, keyword: $('keyword').value, similar: $('similar').value });
  const [ranking, meta] = await Promise.all([fetch(`./api/rankings?${query}`).then(r=>r.json()), fetch('./api/meta').then(r=>r.json())]);
  state.pages = ranking.pagination.pages;
  $('summary').innerHTML = `<span><b>${meta.counts.products}</b> 商品</span><span><b>${meta.counts.favorites}</b> 收藏</span><span><b>${meta.counts.pool}</b> 选品池</span>`;
  $('notice').textContent = ranking.rows.length ? `当前展示已导入的${types.find(x=>x[0]===state.type)[1]}快照。日期和类目将在取得对应接口响应后参与筛选。` : '该榜单暂无数据，请导入对应的响应 JSON。';
  $('rows').innerHTML = ranking.rows.map(row => `<tr>
    <td><strong class="rank">${row.rank_number || '-'}</strong><small class="${row.rank_change>0?'up':row.rank_change<0?'down':''}">${row.rank_change>0?'+':''}${row.rank_change||'-'}</small></td>
    <td><div class="product"><img src="${esc(row.image_url)}" alt="" loading="lazy"><div><strong title="${esc(row.product_name)}">${esc(row.product_name)}</strong><small>${esc(row.shop_name)} · ${esc(row.product_id)}</small></div></div></td>
    <td>${formatRange(esc(row.price_min_display),esc(row.price_max_display))}</td><td>${row.product_score ?? '-'}<small>${row.review_count ? `${row.review_count} 条评价` : ''}</small></td>
    <td><b>${formatRange(esc(row.gmv_min_display),esc(row.gmv_max_display))}</b></td><td>${formatRange(esc(row.click_min_display),esc(row.click_max_display))}</td>
    <td>${formatRange(esc(row.ctr_min_display),esc(row.ctr_max_display))}</td><td>${esc(row.similar_display||row.similar_count||'-')}</td>
    <td><div class="actions"><button title="收藏" data-favorite="${row.product_id}" class="icon ${row.favorite?'selected':''}">★</button><button data-selection="${row.product_id}" class="${row.in_pool?'selected':''}">${row.in_pool?'已入池':'加入选品池'}</button></div></td></tr>`).join('');
  $('pageInfo').textContent = `共 ${ranking.pagination.total} 条 · 第 ${state.page}/${state.pages} 页`;
  $('prev').disabled = state.page <= 1; $('next').disabled = state.page >= state.pages;
  document.querySelectorAll('[data-favorite]').forEach(b=>b.onclick=()=>toggle('favorite',b.dataset.favorite));
  document.querySelectorAll('[data-selection]').forEach(b=>b.onclick=()=>toggle('selection',b.dataset.selection));
}

async function toggle(kind,id){ await fetch(`./api/${kind}/${encodeURIComponent(id)}`,{method:'POST'}); load(); }
$('importBtn').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async event=>{ const file=event.target.files[0]; if(!file)return; try { const parsed=JSON.parse(await file.text()); const isPages=parsed.format==='ajmy-tk-trend-pages-v1'&&Array.isArray(parsed.pages); const url=isPages?'./api/import-pages':'./api/import'; const body=isPages?parsed:{response:parsed,rankingType:state.type}; const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const result=await res.json(); if(!res.ok)throw new Error(result.error); alert(`已导入 ${result.imported} 条，本次接口总数 ${result.total} 条`); state.page=1; load(); } catch(error){ alert(`导入失败：${error.message}`); } event.target.value=''; };
$('keyword').oninput=()=>{ clearTimeout(window.searchTimer); window.searchTimer=setTimeout(()=>{state.page=1;load()},250); };
$('similar').onchange=()=>{state.page=1;load()}; $('prev').onclick=()=>{state.page--;load()}; $('next').onclick=()=>{state.page++;load()};
renderTabs(); load().catch(error=>$('notice').textContent=`加载失败：${error.message}`);
