import { icons } from './data.js';
export const $ = (s, root=document) => root.querySelector(s);
export const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money = cents => '¥' + (cents/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
export const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.box}</svg>`;
export const badge = (label,color='gray') => `<span class="badge ${color}">${esc(label)}</span>`;
export const button = (label, action, variant='', symbol='') => `<button class="btn ${variant}" data-action="${action}">${symbol?icon(symbol):''}${label}</button>`;
export function thumb(id, size='') {
  const slots={cpu:0,board:1,gpu:2,ram:3,ssd:4,cooler:5,power:6,case:7,tower:7,'used-gpu':8,pending:1};
  const n=slots[id]??7;
  return `<span class="hardware ${size}" role="img" aria-label="${esc(id==='tower'?'主机':'硬件')} AI 类别示意" style="background-position:${n%3*50}% ${Math.floor(n/3)*50}%"></span>`;
}
export const field = (label,name,value,type='text',extra='')=>`<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
export function empty(title,sub='',action='') { return `<div class="empty"><div class="empty-icon">${icon('search')}</div><h3>${title}</h3>${sub?`<p>${sub}</p>`:''}${action}</div>`; }
let lastFocus, closeTimer, toastTimer;
export function showDialog(title,content,{drawer=false,wide=false}={}) {
  const d=$('#dialog'); clearTimeout(closeTimer);
  if(!d.open) lastFocus=document.activeElement;
  d.className=`${drawer?'drawer':''} ${wide?'wide':''}`;
  d.innerHTML=`<header class="dialog-head"><div><span class="eyebrow">装一下机 · 演示</span><h2 id="dialog-title">${title}</h2></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body">${content}</div>`;
  if(!d.open) d.showModal();
  requestAnimationFrame(()=>d.classList.add('shown'));
}
export function closeDialog(after) {
  const d=$('#dialog');d.classList.remove('shown');
  const delay=document.documentElement.dataset.input==='keyboard'||matchMedia('(prefers-reduced-motion: reduce)').matches?0:180;
  clearTimeout(closeTimer);closeTimer=setTimeout(()=>{d.close();lastFocus?.focus();after?.();},delay);
}
export function toast(message) { const el=$('#toast');el.innerHTML=icon('check')+esc(message);el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2600); }
export function pulse(el) {
  if(!el || document.documentElement.dataset.input==='keyboard'||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  el.getAnimations().forEach(a=>a.cancel());
  el.animate([{opacity:.45,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:160,easing:'cubic-bezier(0.23, 1, 0.32, 1)'});
}
document.addEventListener('keydown',()=>document.documentElement.dataset.input='keyboard');
document.addEventListener('pointerdown',()=>document.documentElement.dataset.input='pointer');
$('#dialog').addEventListener('cancel',e=>{e.preventDefault();closeDialog();});
$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')) {const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeDialog();}});
