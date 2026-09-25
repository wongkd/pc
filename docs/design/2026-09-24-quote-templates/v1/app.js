// Independent prototype: state lives only in this page, with no network or storage writes.
const $ = (selector) => document.querySelector(selector);
const BASE = ['CPU', '散热器', '主板', '内存', '显卡', '固态硬盘', '电源', '机箱'];
const EXTRAS = ['显示器', '键鼠套装', '机箱风扇', '机械硬盘', '装机服务'];
const HINTS = { CPU:'处理器型号', 散热器:'散热器型号 / 原装散热', 主板:'主板型号', 内存:'内存套装型号与容量', 显卡:'显卡型号', 固态硬盘:'固态型号与容量', 电源:'电源型号与功率', 机箱:'机箱型号与颜色', 显示器:'显示器型号', 键鼠套装:'键鼠套装型号', 机箱风扇:'风扇型号', 机械硬盘:'机械硬盘型号与容量', 装机服务:'服务内容' };
const INFO = {
  a:{label:'方案 A / 预置基础清单',title:'新建就有常用配件',benefitTitle:'每一单，少做重复的准备',benefit:'默认排好 8 类配件。数量先填 1，型号、单价留空。直接连续录入，用不到的行可以删除。',effort:'低',caution:'默认 8 类是可编辑清单。CPU 自带散热、无需独显等情况可删行；没有填写型号的类别不能保存成商品。'},
  b:{label:'方案 B / 按场景起步',title:'先选这次怎么装',benefitTitle:'清单随用途变，少增删几次',benefit:'独显主机、核显办公、旧机升级各有起点，显示器、键鼠与装机服务按需加入；共同配件保留已填内容。',effort:'低—中',caution:'核显方案要确认 CPU 支持图形输出；升级方案要核对原机器。模板不代表兼容性已验证。'},
  c:{label:'方案 C / 店内常用配置',title:'从常卖的一整套开始',benefitTitle:'型号也不需要再抄一遍',benefit:'套用店内成熟配置，保留型号和数量。参考价格明确标记待复核，再按客户需求换件；后续可把好用的报价存成模板。',effort:'中—高',caution:'正式功能需要门店模板管理、权限与价格更新规则。不可复制上次客户、二手实物、客供设备和旧单确认状态。'},
  d:{label:'方案 D / 整单粘贴',title:'已有清单，一次带进来',benefitTitle:'从逐格抄写，变成逐行核对',benefit:'支持 Excel 四列或用竖线分隔的规范文本：配件、型号、数量、单价。先识别预览，确认无格式错误后带入。',effort:'中—高',caution:'自由格式微信文字需要另做识别与纠错。型号匹配不唯一、价格缺失或来源不明时，必须由店员核对。'}
};
const SCENARIOS = {
  gaming:{name:'独显主机',cats:BASE,note:'标准 8 类配件。显卡、电源、机箱空间与接口需要人工核对。'},
  office:{name:'核显办公',cats:BASE.filter(x=>x!=='显卡'),note:'暂不列独立显卡。请确认所选 CPU 支持图形输出；散热可按盒装情况调整。'},
  upgrade:{name:'旧机升级',cats:['CPU','主板','内存','固态硬盘','装机服务'],note:'先列常换的 4 类配件与服务。旧件需要写入报价时，再按客供件登记并关联客户设备。'}
};
const TEMPLATES = [
  {id:'office',name:'日常办公 · 示例',tag:'7 项 / 核显配置',rows:[['CPU','办公处理器 A',650],['散热器','风冷散热器 A',70],['主板','办公主板 A',450],['内存','16GB 双条套装 A',220],['固态硬盘','500GB 固态 A',230],['电源','额定 400W 电源 A',220],['机箱','简约机箱 A',160]]},
  {id:'gaming',name:'主流游戏 · 示例',tag:'8 项 / 独显配置',rows:[['CPU','游戏处理器 B',1100],['散热器','塔式散热器 B',160],['主板','游戏主板 B',800],['内存','32GB 双条套装 B',500],['显卡','独立显卡 B',2300],['固态硬盘','1TB 固态 B',420],['电源','额定 650W 电源 B',430],['机箱','通风机箱 B',280]]},
  {id:'design',name:'设计大内存 · 示例',tag:'8 项 / 大容量配置',rows:[['CPU','创作处理器 C',1600],['散热器','塔式散热器 C',250],['主板','创作主板 C',1000],['内存','64GB 双条套装 C',900],['显卡','独立显卡 C',2800],['固态硬盘','2TB 固态 C',800],['电源','额定 750W 电源 C',550],['机箱','工作站机箱 C',400]]}
];
const SAMPLE = 'CPU | 示例处理器 A | 1 | 650\n主板 | 示例主板 A | 1 | 450\n内存 | 示例 32GB 双条套装 | 1 | 420\n固态硬盘 | 示例 1TB 固态 | 1 | 380';
let seq = 0;
const line = (cat, name='',price='') => ({id:++seq,cat,name,qty:'1',price:String(price),source:cat==='装机服务'?'service':'new'});
const fresh = () => ({a:{rows:BASE.map(c=>line(c))},b:{rows:BASE.map(c=>line(c)),scenario:'gaming',extras:[],parked:[]},c:{rows:[],template:'office',keepPrice:false,appliedWithPrice:false},d:{rows:[],text:SAMPLE,parsed:null}});
const state = fresh();
let mode='a';
let timer;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:2}).format(cents/100);
const cents = raw => /^\d+(?:\.\d{1,2})?$/.test(raw.trim()) && Number.isSafeInteger(Math.round(Number(raw)*100)) ? Math.round(Number(raw)*100) : null;
const validQty = raw => /^\d+$/.test(raw) && Number(raw)>0 && Number.isSafeInteger(Number(raw));
function lineTotal(row){const price=row.source==='customer'?0:cents(row.price);return row.name.trim()&&validQty(row.qty)&&price!==null?price*Number(row.qty):null;}
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>$('#toast').hidden=true,3400);}
function sourceOptions(row){return Object.entries({new:'新品',used:'二手',customer:'客供',service:'服务'}).map(([value,label])=>`<option value="${value}" ${row.source===value?'selected':''}>${label}</option>`).join('');}
function renderRows(){
  const rows=state[mode].rows;
  $('#rows').innerHTML=rows.length?rows.map(row=>`<tr data-id="${row.id}"><td class="category">${escape(row.cat)}<small>${row.source==='used'?'待选二手实物':row.source==='customer'?'待关联客户设备':row.source==='service'?'服务项目':'配件类别'}</small></td><td><input data-field="name" aria-label="${escape(row.cat)}型号" value="${escape(row.name)}" placeholder="${escape(HINTS[row.cat]||'具体型号')}" autocomplete="off"></td><td><select data-field="source" aria-label="${escape(row.cat)}来源">${sourceOptions(row)}</select></td><td><input data-field="qty" aria-label="${escape(row.cat)}数量" value="${escape(row.qty)}" inputmode="numeric" ${['customer','used'].includes(row.source)?'disabled':''}></td><td><input data-field="price" aria-label="${escape(row.cat)}单价" value="${escape(row.source==='customer'?'0':row.price)}" placeholder="待填" inputmode="decimal" ${row.source==='customer'?'disabled':''}></td><td data-subtotal class="pending-price">待填</td><td><button class="delete" data-remove="${row.id}" aria-label="移除${escape(row.cat)}">×</button></td></tr>`).join(''):'<tr><td colspan="7" style="padding:30px;text-align:center;color:#7b8593">先从上方选择配置或导入清单，也可以在下方逐项添加。</td></tr>';
  $('#row-count').textContent=`${rows.length} 项`;
  $('#add-options').innerHTML=[...EXTRAS,'CPU','散热器','主板','内存','显卡','固态硬盘','电源','机箱'].map(cat=>`<button data-add="${cat}">+ ${cat}</button>`).join('');
  $('#review-result').textContent='';
  updateTotals();
}
function updateTotals(){
  const rows=state[mode].rows,priced=rows.map(lineTotal).filter(x=>x!==null);
  $('#total').textContent=priced.length?money(priced.reduce((sum,x)=>sum+x,0)):'—';
  $('#filled').textContent=String(rows.filter(row=>row.name.trim()).length);
  $('#pending').textContent=String(rows.filter(row=>lineTotal(row)===null).length);
  $('#summary-note').textContent=mode==='c'&&state.c.appliedWithPrice?'模板参考价已带入，全部需要重新核价；型号与金额均为虚构示例。':'未填写的行不计价；“待填”不等于 0 元。内存为双条套装时，数量 1 代表 1 套。';
  document.querySelectorAll('tr[data-id]').forEach(tr=>{const row=rows.find(r=>r.id===Number(tr.dataset.id));const total=lineTotal(row);tr.querySelector('[data-subtotal]').textContent=total===null?'待填':money(total);tr.querySelector('[data-subtotal]').classList.toggle('pending-price',total===null);});
}
function renderControls(){
  if(mode==='a') $('#controls').innerHTML='<div class="controls-box"><div class="controls-title"><strong>默认标准主机 · 8 类基础配件</strong><span class="subtle">数量默认 1</span></div><p>CPU、散热器、主板、内存、显卡、固态硬盘、电源、机箱。点第一行直接填写，按 Tab 连续移动。</p></div>';
  if(mode==='b'){
    const current=state.b;
    $('#controls').innerHTML=`<div class="controls-box"><div class="controls-title"><strong>这次装什么</strong><span class="subtle">只改变配件结构，不自动选型号</span></div><div class="chips">${Object.entries(SCENARIOS).map(([key,item])=>`<button class="chip" data-scenario="${key}" aria-pressed="${current.scenario===key}">${item.name}</button>`).join('')}</div><p class="helper">${SCENARIOS[current.scenario].note}</p><div class="options">${['显示器','键鼠套装','装机服务'].map(cat=>`<label><input type="checkbox" data-extra="${cat}" ${current.extras.includes(cat)?'checked':''}>${cat}</label>`).join('')}</div><p class="helper" style="margin-top:8px">切换场景时隐藏的配件会暂存；切回来仍保留当前页内的填写内容。</p></div>`;
  }
  if(mode==='c'){
    const selected=TEMPLATES.find(t=>t.id===state.c.template);
    $('#controls').innerHTML=`<div class="controls-box"><div class="controls-title"><strong>店内模板库 · 虚构示例</strong><span class="subtle">正式版可收藏常用配置</span></div><div class="template-grid">${TEMPLATES.map(t=>`<button class="template-card" data-template="${t.id}" aria-pressed="${state.c.template===t.id}"><strong>${t.name}</strong><span>${t.tag}</span></button>`).join('')}</div><div class="template-preview"><strong>预览：${selected.name}</strong><br>${selected.rows.map(r=>escape(r[1])).join(' / ')}<br>示例价格合计 ${money(selected.rows.reduce((sum,r)=>sum+r[2]*100,0))} · 非市场报价</div><div class="action-row"><button class="button primary" id="apply-template">套用到下方演示清单</button><label><input type="checkbox" id="keep-price" ${state.c.keepPrice?'checked':''}> 带入参考价（仍需核价）</label></div><p class="helper" style="margin-top:10px">默认只带型号与数量。已有内容时需确认替换；不会带入客户、二手实物和客供设备。</p></div>`;
  }
  if(mode==='d') $('#controls').innerHTML=`<div class="controls-box"><div class="controls-title"><strong>粘贴配置</strong><span class="subtle">配件 | 型号 | 数量 | 单价</span></div><p class="helper">支持竖线分隔文本或 Excel 四列（Tab 分隔）；首行表头可省略。价格可空，待后续补全。</p><textarea class="paste-area" id="paste-input" aria-label="粘贴配置文本" spellcheck="false">${escape(state.d.text)}</textarea><div class="action-row"><button class="button primary" id="parse">识别并预览</button><button class="button" id="apply-paste" ${!state.d.parsed||state.d.parsed.errors.length?'disabled':''}>带入演示清单</button></div><div id="parse-result" class="parse-result" role="status"></div></div>`;
  if(mode==='d'&&state.d.parsed) renderParse();
}
function render(){
  document.querySelectorAll('[data-variant]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.variant===mode)));
  const info=INFO[mode];
  for(const [id,key] of Object.entries({'mode-label':'label','editor-title':'title','benefit-title':'benefitTitle',benefit:'benefit',effort:'effort',caution:'caution'})) $('#'+id).textContent=info[key];
  renderControls();renderRows();
}
function changeScenario(){
  const current=state.b,cats=[...new Set([...SCENARIOS[current.scenario].cats,...current.extras])];
  const pool=[...current.rows,...current.parked];
  const picked=[];
  for(const cat of cats){const matches=pool.filter(r=>r.cat===cat);picked.push(...(matches.length?matches:[line(cat)]));}
  current.parked=pool.filter(row=>!cats.includes(row.cat));current.rows=picked;render();
}
function parseText(text){
  const errors=[],rows=[],notes=[];
  const source=text.replace(/\r/g,'').split('\n').filter(value=>value.trim());
  if(source.length>80) return {rows:[],notes:[],errors:['最多导入 80 行，请分批整理。']};
  source.forEach((raw,index)=>{
    const fields=raw.includes('\t')?raw.split('\t'):raw.split(/[|｜]/);
    const cells=fields.map(value=>value.trim());
    if(index===0&&['配件','类别'].includes(cells[0])&&/型号|名称/.test(cells[1]||'')) return;
    const [cat,name,qty,price]=cells;
    if(cells.length!==4||!cat||!name){errors.push(`第 ${index+1} 行：需要“配件、型号、数量、单价”四列，配件与型号不能为空。`);return;}
    if(!validQty(qty)){errors.push(`第 ${index+1} 行：数量须为正整数。`);return;}
    if(price&&cents(price)===null){errors.push(`第 ${index+1} 行：单价须为非负数字，最多两位小数。`);return;}
    const row=line(cat,name,price);row.qty=qty;rows.push(row);
    if(![...BASE,...EXTRAS].includes(cat)) notes.push(`第 ${index+1} 行：“${cat}”为自定义类别，需核对。`);
  });
  if(!rows.length&&!errors.length) errors.push('请先粘贴至少一项配置。');
  return {rows,errors,notes};
}
function renderParse(){
  const result=state.d.parsed;
  $('#parse-result').textContent=result.errors.length?result.errors.join('\n'):`识别到 ${result.rows.length} 项，${result.rows.filter(r=>!r.price).length} 项待填价格。\n${result.rows.map(r=>`${r.cat} · ${r.name} × ${r.qty} · ${r.price?money(cents(r.price)):'待核价'}`).join('\n')}${result.notes.length?'\n'+result.notes.join('\n'):''}\n全部为待关联商品的临时行，导入不等于完成核价或兼容性检查。`;
  $('#apply-paste').disabled=Boolean(result.errors.length);
}
function confirmReplacement(rows){return !rows.some(r=>r.name.trim()||r.price.trim())||window.confirm('下方演示清单已有填写内容，替换为本次选择？这只改变本方案的页内演示内容。');}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button) return;
  if(button.dataset.variant){mode=button.dataset.variant;render();}
  else if(button.dataset.scenario){state.b.scenario=button.dataset.scenario;changeScenario();}
  else if(button.dataset.template){state.c.template=button.dataset.template;renderControls();}
  else if(button.dataset.add){state[mode].rows.push(line(button.dataset.add));renderRows();toast(`已加入${button.dataset.add}`);}
  else if(button.dataset.remove){state[mode].rows=state[mode].rows.filter(r=>r.id!==Number(button.dataset.remove));renderRows();}
  else if(button.id==='reset'){if(confirmReplacement(state[mode].rows)){state[mode]=fresh()[mode];render();toast('已重置本方案演示');}}
  else if(button.id==='apply-template'){
    if(!confirmReplacement(state.c.rows)) return;
    const selected=TEMPLATES.find(t=>t.id===state.c.template);
    state.c.rows=selected.rows.map(([cat,name,price])=>line(cat,name,state.c.keepPrice?price:''));state.c.appliedWithPrice=state.c.keepPrice;renderRows();toast('已套用到演示清单，请核对型号与价格');
  } else if(button.id==='parse'){state.d.parsed=parseText(state.d.text);renderParse();}
  else if(button.id==='apply-paste'){
    if(!state.d.parsed||state.d.parsed.errors.length||!confirmReplacement(state.d.rows)) return;
    state.d.rows=state.d.parsed.rows.map(row=>({...row,id:++seq}));renderRows();toast('已带入页内演示清单，尚未关联真实商品');
  } else if(button.id==='review'){
    const rows=state[mode].rows,blank=rows.filter(r=>!r.name.trim()).length,unpriced=rows.filter(r=>r.name.trim()&&lineTotal(r)===null).length;
    $('#review-result').textContent=!rows.length?'当前还没有配置。':`检查：${blank} 项未填型号，${unpriced} 项价格或数量待补。${rows.some(r=>['used','customer'].includes(r.source))?'二手 / 客供件还需绑定具体实物或设备。':''}本页仅演示，真实商品、库存与兼容性均未核实。`;
  }
});
document.addEventListener('input',event=>{
  const input=event.target;
  if(input.id==='paste-input'){state.d.text=input.value;state.d.parsed=null;$('#apply-paste').disabled=true;$('#parse-result').textContent='文本已更改，请重新识别。';}
  if(input.matches('input[data-field]')){
    const row=state[mode].rows.find(r=>r.id===Number(input.closest('tr').dataset.id));row[input.dataset.field]=input.value;$('#review-result').textContent='';updateTotals();
  }
});
document.addEventListener('change',event=>{
  const input=event.target;
  if(input.dataset.extra){const extras=state.b.extras;state.b.extras=input.checked?[...extras,input.dataset.extra]:extras.filter(c=>c!==input.dataset.extra);changeScenario();}
  if(input.id==='keep-price'){state.c.keepPrice=input.checked;toast('下次套用模板时生效');}
  if(input.matches('select[data-field="source"]')){
    const row=state[mode].rows.find(r=>r.id===Number(input.closest('tr').dataset.id));const previous=row.source;row.source=input.value;
    if(['used','customer'].includes(row.source))row.qty='1';
    if(row.source==='customer')row.price='0';else if(previous==='customer')row.price='';
    renderRows();
  }
});
render();
