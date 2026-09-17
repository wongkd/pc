const MEDIA={
  case:'https://images-na.ssl-images-amazon.com/images/I/71pH1e8YtBL.jpg',
  pc:'https://images.unsplash.com/photo-1658673847822-915a94725183?auto=format&fit=crop&w=1400&q=85',
  studio:'https://images.unsplash.com/photo-1653372500696-416ccecafa08?auto=format&fit=crop&w=1600&q=85',
  desk:'https://images.unsplash.com/photo-1634891392987-e91db6bf9557?auto=format&fit=crop&w=1600&q=85',
  gpu:'https://cdn.awsli.com.br/2500x2500/2539/2539199/produto/331806518/64960--2--es4z13rivg.png'
};
const SHAPES={home:'M3 10 12 3l9 7v10H3Z M9 20v-7h6v7',order:'M6 3h12v18H6Z M9 8h6 M9 12h6 M9 16h4',box:'M3 7 12 3l9 4v11l-9 4-9-4Z M3 7l9 5 9-5 M12 12v10',repair:'M14 4a6 6 0 0 0-7 8L3 17l4 4 5-5a6 6 0 0 0 8-7l-4 4-5-5Z',recycle:'m15 4 4 3-4 3 M19 7H9a5 5 0 0 0-5 5 M9 20l-4-3 4-3 M5 17h10a5 5 0 0 0 5-5',book:'M4 3h16v18H4Z M8 3v18 M12 8h5 M12 12h5',search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',scan:'M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M7 7v10 M10 7v10 M14 7v10 M17 7v10',settings:'M12 3v3 M12 18v3 M3 12h3 M18 12h3 M6 6l2 2 M16 16l2 2 M6 18l2-2 M16 8l2-2 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',more:'M4 5h5v5H4Z M15 5h5v5h-5Z M4 15h5v5H4Z M15 15h5v5h-5Z',check:'m5 12 4 4L19 6',arrow:'M4 12h16 M15 7l5 5-5 5',back:'m14 5-7 7 7 7',plus:'M12 5v14 M5 12h14',photo:'M3 6h5l2-3h4l2 3h5v15H3Z M12 9a4 4 0 1 0 0 8 4 4 0 0 0 0-8',phone:'M6 3h4l1 5-3 2a14 14 0 0 0 6 6l2-3 5 1v4c0 6-18-3-18-12 0-2 1-3 3-3',filter:'M4 6h16 M7 12h10 M10 18h4',print:'M7 8V3h10v5 M7 17H3V9h18v8h-4 M7 14h10v7H7Z',close:'m5 5 14 14 M19 5 5 19',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 6v6l4 3'};
function icon(name){return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${SHAPES[name]||SHAPES.box}"/></svg>`;}
function photo(key,cls='',alt='设备示意图'){return `<img class="${cls}" src="${MEDIA[key]}" alt="${alt}">`;}
function hydrate(){document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));document.querySelectorAll('img[data-photo]').forEach(el=>el.src=MEDIA[el.dataset.photo]);}
function toast(message){let t=document.querySelector('.prototype-toast');if(!t){t=document.createElement('div');t.className='prototype-toast';t.setAttribute('role','status');document.body.append(t);}t.textContent=message;t.hidden=false;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.hidden=true,2800);}
document.addEventListener('DOMContentLoaded',()=>{hydrate();document.querySelectorAll('[data-preview]').forEach(b=>b.addEventListener('click',()=>toast('操作预览：'+b.dataset.preview+'，未写入业务数据')));});
