import {tasks} from './data.js';
import {money, icon, badge, button, thumb, empty} from './ui.js';

// 主列表用于比较与选择，右侧只处理当前订单。指标会交叉，不作为总单量相加。
export function renderWorkbench(state, {paid, stage, actionFor}) {
  const visible = tasks.filter(t => (state.filter === '全部' || t.type === state.filter ||
    (state.filter === '收款' && paid(t) < t.amount)) && (state.scope !== '我的' || t.owner === '我'));
  visible.sort((a,b) => Number(b.type === '异常') - Number(a.type === '异常') || a.when.localeCompare(b.when));
  const selected = visible.find(t => t.id === state.task) || visible[0];
  if (selected) state.task = selected.id;
  const metrics = [
    {label:'今日交付',filter:'交付',count:tasks.filter(t=>t.type==='交付').length,tone:'mint',symbol:'case',note:'按承诺时间安排交付'},
    {label:'缺件待办',filter:'缺件',count:tasks.filter(t=>stage(t)===1).length,tone:'peach',symbol:'box',note:'已收定金，跟进到货'},
    {label:'待收款',filter:'收款',count:tasks.filter(t=>paid(t)<t.amount).length,tone:'lilac',symbol:'wallet',note:'核实款项后继续履约'},
    {label:'异常订单',filter:'异常',count:tasks.filter(t=>t.type==='异常'&&stage(t)<4).length,tone:'rose',symbol:'alert',note:'优先处理交期与异常'},
  ];
  return `<div class="page-head"><div><div class="page-kicker">门店经营 / 2026.09.19 · 星期六</div><h1>工作台<span class="title-dot"></span></h1></div><div class="head-actions"><span class="date-chip">${icon('clock')} 今日事项</span>${button('新建报价','go-quote','primary','plus')}</div></div>
    <div class="overview-label"><h2>今天需要关注</h2><span>虚构样本 · 同一订单可计入多个指标</span></div>
    <div class="overview-cards">${metrics.map(m=>`<button class="overview-card ${m.tone} ${state.filter===m.filter?'chosen':''}" data-filter="${m.filter}" aria-pressed="${state.filter===m.filter}"><div class="row"><span>${m.label}</span><span class="metric-icon">${icon(m.symbol)}</span></div><div class="metric-number">${m.count}<small>单</small></div><div class="metric-foot"><span>${m.note}</span><span class="metric-arrow">${icon('arrow')}</span></div></button>`).join('')}</div>
    ${state.scenario==='error'?`<section class="panel">${empty('待办加载失败','已有样本保留，重试后恢复显示。',button('重新加载','retry','primary'))}</section>`:
      state.scenario==='empty'?`<section class="panel">${empty('今日事项已处理','现在可以创建新的报价。',button('新建报价','go-quote','primary'))}</section>`:
    `<div class="desk-layout"><section class="queue-panel"><div class="queue-heading"><div><h2>待办队列 <span>${visible.length}</span></h2><p>逾期优先，其次按约定时间处理</p></div><div class="segments">${['全店','我的'].map(x=>`<button data-scope="${x}" class="${state.scope===x?'selected':''}">${x}</button>`).join('')}</div></div>
    <div class="queue-filters"><div class="chip-bar">${['全部','缺件','交付','收款','异常'].map(f=>`<button data-filter="${f}" class="chip ${state.filter===f?'selected':''}">${f}</button>`).join('')}</div><span>客户 / 设备 / 当前卡点</span></div>
    <div class="queue-list">${visible.length?visible.map(t=>`<button class="queue-row ${selected.id===t.id?'selected':''}" data-task="${t.id}" aria-pressed="${selected.id===t.id}"><span class="customer-avatar ${t.color}">${t.name.slice(0,1)}</span><span class="queue-object"><strong>${t.name}<small>${t.id.slice(-3)}</small></strong><span>${t.title}</span></span><span class="queue-status">${badge(stage(t)===4?'演示已交付':t.tag,t.color)}<small>${t.when}</small></span><span class="queue-amount"><strong>${money(t.amount-paid(t))}</strong><small>待收款</small></span><span class="row-arrow">${icon('chevron')}</span></button>`).join(''):empty('没有匹配待办','切换全店或清除筛选。',button('查看全部','all-tasks','text'))}</div>
    <div class="queue-bottom"><span><i></i> 所有金额、库存与客户均为演示样本</span><span>${visible.length} 项事项</span></div>
    <section class="appointments"><div class="row"><h2>今日交付安排</h2><small>2 项预约 · 到店自取</small></div><div class="appointment-grid">${tasks.filter(t=>t.type==='交付').map(t=>`<button data-order="${t.id}" class="appointment"><time>${t.when.replace('今天 ','')}</time><span><strong>${t.name}</strong><small>${t.title}</small></span>${icon('arrow')}</button>`).join('')}</div></section></section>
    ${selected?detail(selected,paid,stage,actionFor):`<aside class="focus-panel">${empty('请选择待办','右侧展示单据与下一步。')}</aside>`}</div>`}`;
}

function detail(t,paid,stage,actionFor) {
  const phase=stage(t);
  const blocker=phase===4?'演示交付核对完成':phase===1?'显卡尚未到货':phase===2?'装机检测待完成':paid(t)<t.amount?'款项需要核实':'核对实物后交付';
  const description=phase===1?'其余配件已齐备。先跟进在途显卡，再安排装机。':phase===2?'核对外观、开机、存储与负载四项检测。':paid(t)<t.amount?'收款与交付分别留痕，核实到账后再继续。':'核对客户、配件与交付清单；正式系统由服务端扣库。';
  return `<aside class="focus-panel" id="selected-task"><div class="focus-caption"><span>当前处理</span><span class="focus-owner">${t.owner==='我'?'陈店长':t.owner}负责</span></div>
    <div class="focus-person"><div><small>${t.id}</small><h2>${t.name}</h2><p>${t.title}</p></div>${thumb(t.type==='收款'?'used-gpu':'tower')}</div>
    ${button(actionFor(t),'go-order','primary full','arrow')}<div class="fulfillment-strip">${['配置','备货','检测','交付'].map((l,i)=>`<span class="${phase>i?'done':phase===i?'current':''}"><i>${phase>i?icon('check'):i+1}</i>${l}</span>`).join('')}</div>
    <div class="focus-money"><span>待收款</span><strong>${money(t.amount-paid(t))}</strong><div class="row"><small>总额 ${money(t.amount)}</small><small>已收 ${money(paid(t))}</small></div></div>
    <div class="focus-blocker"><div>${icon(phase===1?'box':'clock')}<span>当前卡点</span></div><h3>${blocker}</h3><p>${description}</p></div>
    <div class="focus-deadline"><span>承诺交付</span><strong>${t.when}</strong></div>
    <button class="btn text full" data-action="go-order">查看完整订单</button>
    <p class="focus-note">原型演练，不会创建真实收款或库存流水</p></aside>`;
}
