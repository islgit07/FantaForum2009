
(() => {
const $=selector=>document.querySelector(selector);
const state={faction:'forum',nickname:'',publicGender:'保密',publicAge:'保密',zoom:1,x:0,y:0};
let avatar=null,portrait=null,avatarVersion=0,portraitVersion=0,avatarLoading=false,portraitLoading=false;
const status=$('#status');
let previewScale=1;
function fitPreview(){
 const viewport=$('#preview-viewport');
 if(!viewport.clientWidth)return;
 previewScale=viewport.clientWidth/1600;
 $('#sheet').style.transform='scale('+previewScale+')';
 viewport.style.height=(1000*previewScale)+'px';
}
new ResizeObserver(fitPreview).observe($('#preview-viewport'));

const setStatus=text=>status.textContent=text;
const music=$('#background-music');music.volume=.45;
function updateMusicButton(){
 $('#music-toggle').textContent='音乐：'+(music.paused?'关闭':'开启');
 $('#music-toggle').setAttribute('aria-pressed',String(!music.paused));
}
function enterSite(){
 $('#music-gate').hidden=true;$('#main-content').hidden=false;
 $('#music-toggle').focus();
}
async function enableMusic(){
 try{await music.play();updateMusicButton();return true;}
 catch{music.pause();updateMusicButton();setStatus('音乐暂时无法播放，请点击音乐开关重试。');return false;}
}

let welcomeStarted=false,welcomeFinished=false,welcomeTimer;
function finishWelcome(){
 if(welcomeFinished)return;
 welcomeFinished=true;clearTimeout(welcomeTimer);
 $('#welcome-scene').hidden=true;$('#main-content').hidden=false;
 $('#registration').classList.add('registration-enter');
 $('#registration').elements.nickname.focus();
}
function drawWelcome(count){
 const low=document.createElement('canvas');low.width=400;low.height=45;
 const ctx=low.getContext('2d',{willReadFrequently:true});
 ctx.fillStyle='#e1b4a3';ctx.font='22px SimSun,"Songti SC",serif';ctx.textBaseline='middle';
 const message='欢迎注册怪啖论坛！'.slice(0,count);
 ctx.fillText(message,16,22);
 const pixels=ctx.getImageData(0,0,400,45);
 for(let i=3;i<pixels.data.length;i+=4)pixels.data[i]=pixels.data[i]>100?255:0;
 ctx.putImageData(pixels,0,0);
 if(count<9){ctx.fillStyle='#cb4532';ctx.fillRect(18+ctx.measureText(message).width,10,2,24);}
 const output=$('#welcome-text').getContext('2d');
 output.clearRect(0,0,800,90);output.imageSmoothingEnabled=false;output.drawImage(low,0,0,800,90);
}
function startWelcome(){
 if(welcomeStarted)return;
 welcomeStarted=true;$('#music-gate').hidden=true;$('#welcome-scene').hidden=false;
 const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 let count=0;
 function tick(){
  if(welcomeFinished)return;
  count=reduced?9:count+1;drawWelcome(count);
  if(count<9)welcomeTimer=setTimeout(tick,230);
  else{$('#welcome-status').textContent='欢迎注册怪啖论坛！';welcomeTimer=setTimeout(finishWelcome,reduced?700:1800);}
 }
 tick();
}
$('#music-yes').onclick=()=>{
 music.play().catch(()=>{$('#music-toggle').textContent='音乐：点击开启';});
 startWelcome();
};
$('#music-no').onclick=()=>{music.pause();updateMusicButton();startWelcome();};
$('#music-toggle').onclick=()=>{if(!$('#music-gate').hidden)return;if(music.paused)enableMusic();else{music.pause();updateMusicButton();}};
music.addEventListener('play',updateMusicButton);
music.addEventListener('pause',updateMusicButton);
music.addEventListener('error',()=>{updateMusicButton();$('#music-toggle').textContent='音乐：加载失败，点击重试';});

document.querySelectorAll('.window-icon').forEach(canvas=>{
 const c=canvas.getContext('2d');
 c.strokeStyle='#c9aaa0';c.lineWidth=2;c.strokeRect(3,3,24,32);
 c.fillStyle='#b19087';c.fillRect(7,8,16,4);
 for(const y of [18,24,30]){c.fillStyle='#95756f';c.fillRect(7,y,16,2);}
});

const portraitScan=$('#portrait-scanlines').getContext('2d');
for(let y=0;y<667;y+=3){portraitScan.fillStyle='rgba(0,0,0,.08)';portraitScan.fillRect(0,y,367,1);}
const scanlineContext=$('#scanline-texture').getContext('2d');
for(let y=0;y<1000;y+=4){
 scanlineContext.fillStyle='rgba(0,0,0,.17)';
 scanlineContext.fillRect(0,y,1600,1);
 scanlineContext.fillStyle='rgba(188,192,197,.035)';
 scanlineContext.fillRect(0,y+1,1600,1);
}


function drawForumSignature(ctx,x,y){
 const pixels=document.createElement('canvas');pixels.width=250;pixels.height=44;
 const p=pixels.getContext('2d',{willReadFrequently:true});
 p.fillStyle='#d2c0b2';p.textBaseline='top';p.font='20px SimSun,"Songti SC",serif';p.fillText('怪啖论坛',0,0);
 p.font='12px "Courier New",monospace';p.fillText('www.FantaForum.fmi',0,29);
 const data=p.getImageData(0,0,250,44);
 for(let i=3;i<data.data.length;i+=4)data.data[i]=data.data[i]>105?220:0;
 p.putImageData(data,0,0);
 ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(pixels,x,y,500,88);ctx.restore();
}
drawForumSignature($('#forum-signature').getContext('2d'),0,0);







function paintSmile(ctx,x,y,height){
 ctx.save();ctx.translate(x,y);ctx.scale(height/340,height/340);
 ctx.strokeStyle='#35424b';ctx.lineWidth=2;ctx.lineCap='round';ctx.lineJoin='round';
 ctx.beginPath();ctx.arc(70,25,20,0,Math.PI*2);ctx.stroke();
 ctx.beginPath();
 ctx.moveTo(49,55);ctx.bezierCurveTo(31,58,27,73,25,91);
 ctx.lineTo(16,174);ctx.bezierCurveTo(14,190,30,193,33,177);
 ctx.lineTo(44,105);ctx.lineTo(43,187);
 ctx.lineTo(39,284);ctx.bezierCurveTo(38,303,62,303,63,285);
 ctx.lineTo(69,204);ctx.lineTo(71,204);ctx.lineTo(77,285);
 ctx.bezierCurveTo(78,303,102,303,101,284);
 ctx.lineTo(97,187);ctx.lineTo(96,105);ctx.lineTo(107,177);
 ctx.bezierCurveTo(110,193,126,190,124,174);
 ctx.lineTo(115,91);ctx.bezierCurveTo(113,73,109,58,91,55);
 ctx.closePath();ctx.stroke();ctx.restore();
}
paintSmile($('#pixel-smile').getContext('2d'),20,12,300);



function drawBackgroundDetails(ctx){
 const office=state.faction==='office';
 const solid=office?'#8e211d':'#142e50';
 const dark=office?'#530f16':'#081b34';
 const light=office?'#bd4934':'#375a7e';
 ctx.save();
 const blocks=[
 [0,153,103,19],[30,178,47,8],[3,724,69,35],
 [413,0,163,16],[535,18,61,7],
 [824,45,73,18],[868,71,32,9],
 [1435,187,165,24],[1508,217,92,11],
 [1339,958,209,22],[1468,941,92,8],
 [77,944,192,19],[198,967,91,8],
 [1549,634,51,69],[1571,712,29,13]
 ];
 for(const [i,[x,y,w,h]] of blocks.entries()){
  ctx.globalAlpha=i%3===0?.56:.34;ctx.fillStyle=solid;ctx.fillRect(x,y,w,h);
  ctx.globalAlpha=.5;ctx.fillStyle=dark;ctx.fillRect(x+7,y+5,w*.5,Math.max(3,h*.42));
  ctx.globalAlpha=.3;ctx.fillStyle=light;ctx.fillRect(x-4,y-2,w*.62,2);
 }
 ctx.globalAlpha=.25;ctx.fillStyle=light;
 for(const [x,y,w] of [[0,264,98],[1375,74,225],[1235,984,300]]){
  ctx.fillRect(x,y,w,1);ctx.fillRect(x+13,y+5,w*.7,1);
 }
 ctx.restore();
}
function refreshBackground(){
 const canvas=$('#background-details'),ctx=canvas.getContext('2d');
 ctx.clearRect(0,0,1600,1000);drawBackgroundDetails(ctx);
}
refreshBackground();
const buildingImage=new Image();buildingImage.src="/tools/card/assets/card-asset-1.webp";
const buildingReady=buildingImage.decode();
buildingReady.catch(()=>setStatus('背景楼房未能读取，请刷新重试。'));





const logoSources={"forum":"/tools/card/assets/card-logo-forum.webp","office":"/tools/card/assets/card-logo-office.webp"};
const logos={};
const logoReady=Promise.all(Object.entries(logoSources).map(async([faction,src])=>{
 const image=new Image();image.src=src;await image.decode();
 const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=Math.round(1800*image.height/image.width);
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(image,0,0,canvas.width,canvas.height);
 const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);
 let left=canvas.width,top=canvas.height,right=0,bottom=0;
 for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
  const i=(y*canvas.width+x)*4;
  if(pixels.data[i+3]>0){
   left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
 }
 // Tint the existing artwork while preserving its alpha and internal shading.
 for(let i=0;i<pixels.data.length;i+=4){
   const light=(pixels.data[i]+pixels.data[i+1]+pixels.data[i+2])/765;
   const tone=faction==='forum'?[173,165,161]:[151,175,207];
   const contrast=faction==='office'?Math.min(1,Math.pow(light,.64)*1.15):light;
   pixels.data[i]=tone[0]*contrast;
   pixels.data[i+1]=tone[1]*contrast;
   pixels.data[i+2]=tone[2]*contrast;
 }
 ctx.putImageData(pixels,0,0);
 logos[faction]={image:canvas,left,top,width:right-left+1,height:bottom-top+1};
}));
function paintLogo(ctx,x,y,width,height,faction=state.faction){
 const logo=logos[faction];if(!logo||logo.width<1)return;
 const scale=Math.min(width/logo.width,height/logo.height);
 const w=logo.width*scale,h=logo.height*scale;
 ctx.drawImage(logo.image,logo.left,logo.top,logo.width,logo.height,x+(width-w)/2,y+(height-h)/2,w,h);
}
function drawLogo(){
 const canvas=$('.faction-logo'),ctx=canvas.getContext('2d');
 ctx.clearRect(0,0,canvas.width,canvas.height);
 ctx.save();ctx.translate(canvas.width/2,canvas.height/2);ctx.globalAlpha=state.faction==='office'?.66:.56;paintLogo(ctx,-canvas.width/2,-canvas.height/2,canvas.width,canvas.height);ctx.restore();
}
logoReady.then(()=>{
 drawLogo();
 document.querySelectorAll('[data-faction-logo]').forEach(canvas=>{
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  paintLogo(ctx,0,0,canvas.width,canvas.height,canvas.dataset.factionLogo);
 });
}).catch(()=>setStatus('Logo 读取失败，请刷新重试。'));

function updatePortrait(){
 const frame=$('#portrait-window'), image=$('#portrait-image');
 if(!portrait)return;
 const scale=Math.min(frame.clientWidth/portrait.width,frame.clientHeight/portrait.height)*state.zoom;
 const width=portrait.width*scale,height=portrait.height*scale;
 image.style.width=width+'px';image.style.height=height+'px';
 image.style.left=((frame.clientWidth-width)/2+state.x*frame.clientWidth)+'px';
 image.style.top=((frame.clientHeight-height)/2+state.y*frame.clientHeight)+'px';
 $('#zoom').value=state.zoom;
}
async function loadImage(file){
 if(!file||!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024)throw Error('请选择 10 MB 以内的 PNG、JPG 或 WebP 图片。');
 const url=URL.createObjectURL(file);
 try{
  const image=new Image();image.src=url;await image.decode();
  if(!image.naturalWidth||!image.naturalHeight)throw Error();
  const canvas=document.createElement('canvas');
  const scale=Math.min(1,4800/Math.max(image.naturalWidth,image.naturalHeight));
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
  const normalized=new Image();normalized.src=canvas.toDataURL('image/png');await normalized.decode();
  return normalized;
 }catch(error){throw Error(error.message||'这张图片无法打开。');}
 finally{URL.revokeObjectURL(url);}
}
async function chooseAvatar(file){
 const version=++avatarVersion;avatarLoading=true;$('#enter').disabled=true;
 try{
  const image=await loadImage(file);
  if(version!==avatarVersion)return;
  avatar=image;$('#avatar').src=image.src;$('#avatar-sample').src=image.src;$('#avatar-sample').hidden=false;
  $('#register-avatar').setCustomValidity('');$('#register-status').textContent='';setStatus('');
 }catch(error){if(version===avatarVersion){$('#register-status').textContent=error.message;setStatus(error.message);}}
 finally{if(version===avatarVersion){avatarLoading=false;$('#enter').disabled=false;}}
}
$('#upload-avatar-button').onclick=()=>$('#register-avatar').click();
$('#register-avatar').onchange=event=>{if(event.target.files[0])chooseAvatar(event.target.files[0]);};
$('#replace-avatar').onclick=()=>$('#avatar-file').click();
$('#avatar-file').onchange=event=>{if(event.target.files[0])chooseAvatar(event.target.files[0]);};
$('#registration').onsubmit=event=>{
 event.preventDefault();
 if(avatarLoading)return;
 const form=event.currentTarget, nickname=form.elements.nickname.value.trim();
 if(!avatar||!nickname){$('#register-status').textContent='请上传头像并填写用户名。';return;}
 state.nickname=nickname;state.faction=form.elements.faction.value;
 $('#nickname').value=nickname;
 $('#sheet').classList.toggle('office',state.faction==='office');
 $('#archive-faction').textContent='// '+(state.faction==='office'?'异常对策课':'怪谈侦探');

 drawLogo();
 applyFaction();$('#registration').hidden=true;$('#editor').hidden=false;fitPreview();updatePortrait();
 if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches&&$('#editor').animate){
  $('#editor').animate([{opacity:0,transform:'translateY(14px)'},{opacity:1,transform:'translateY(0)'}],{duration:420,easing:'cubic-bezier(.2,.7,.2,1)'});
 }
 window.scrollTo({top:0,behavior:'instant'});

};

function applyFaction(){
 const office=state.faction==='office';
 $('#sheet').classList.toggle('office',office);
 $('#archive-faction').textContent='// '+(office?'异常对策课':'怪谈侦探');
 $('#switch-faction').textContent='切换阵营：查看'+(office?'怪谈侦探':'异常对策课');
 $('#registration').elements.faction.value=state.faction;
 refreshBackground();drawLogo();
}
$('#switch-faction').onclick=()=>{
 state.faction=state.faction==='office'?'forum':'office';
 applyFaction();
};
$('#back').onclick=()=>{
 $('#registration').elements.nickname.value=state.nickname;
 $('#editor').hidden=true;$('#registration').hidden=false;
};

const fittedFields=[...document.querySelectorAll('[data-key]')];
const lastAccepted=new WeakMap();
function fitField(input){
 if(input.tagName==='SELECT')return true;
 const multiline=input.tagName==='TEXTAREA';
 const preferred=input.dataset.key==='nickname'?36:['signature','intro'].includes(input.dataset.key)?27:multiline?22:22;
 const minimum=multiline?14:12;
 for(let size=preferred;size>=minimum;size--){
  input.style.fontSize=size+'px';
  if(input.scrollWidth<=input.clientWidth+1&&(!multiline||input.scrollHeight<=input.clientHeight+1))return true;
 }
 return false;
}
function acceptField(input){
 if(input.dataset.key==='publicAge')input.value=input.value.replace(/[^0-9]/g,'').slice(0,4);
 if(input.clientWidth>0&&!fitField(input)){
  input.value=lastAccepted.get(input)??'';
  fitField(input);
  setStatus('文字已达到这个框的容量，请精简一些。');
 }else{
  lastAccepted.set(input,input.value);
  setStatus('');
 }
 state[input.dataset.key]=input.value;
}
fittedFields.forEach(input=>{
 lastAccepted.set(input,input.value);
 input.addEventListener('input',event=>{if(!event.isComposing)acceptField(input);});
 input.addEventListener('compositionend',()=>acceptField(input));
 input.addEventListener('blur',()=>acceptField(input));
});
requestAnimationFrame(()=>fittedFields.forEach(input=>{if(input.clientWidth)fitField(input);}));

$('#portrait-file').onchange=async event=>{
 const file=event.target.files[0];if(!file)return;
 const version=++portraitVersion;portraitLoading=true;setStatus('正在读取立绘…');
 try{
  const image=await loadImage(file);
  if(version!==portraitVersion)return;
  portrait=image;$('#portrait-image').src=image.src;$('#portrait-image').hidden=false;$('#portrait-placeholder').hidden=true;$('#replace-portrait').hidden=false;
  state.zoom=1;state.x=state.y=0;updatePortrait();setStatus('');
 }catch(error){if(version===portraitVersion)setStatus(error.message);}
 finally{if(version===portraitVersion)portraitLoading=false;}
};
$('#portrait-placeholder').onclick=event=>{event.stopPropagation();$('#portrait-file').click();};
$('#replace-portrait').onclick=()=>$('#portrait-file').click();
for(const [id,key] of [['zoom','zoom']])$('#'+id).oninput=event=>{state[key]=Number(event.target.value);updatePortrait();};
$('#reset').onclick=()=>{state.zoom=1;state.x=state.y=0;updatePortrait();};
let drag=null;
const frame=$('#portrait-window');
frame.onpointerdown=event=>{
 if(!portrait)return;
 drag={id:event.pointerId,x:event.clientX,y:event.clientY,originalX:state.x,originalY:state.y};
 frame.setPointerCapture(event.pointerId);
};
frame.onpointermove=event=>{
 if(!drag||drag.id!==event.pointerId)return;
 state.x=Math.max(-1,Math.min(1,drag.originalX+(event.clientX-drag.x)/(frame.clientWidth*previewScale*.94)));
 state.y=Math.max(-1,Math.min(1,drag.originalY+(event.clientY-drag.y)/(frame.clientHeight*previewScale*.94)));
 updatePortrait();
};
frame.onpointerup=frame.onpointercancel=frame.onlostpointercapture=()=>drag=null;
new ResizeObserver(updatePortrait).observe(frame);
function makeCard(){
 const canvas=document.createElement('canvas');canvas.width=4800;canvas.height=3000;
 const c=canvas.getContext('2d'),office=state.faction==='office';
 c.scale(3,3);c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';
 const palette=office?{base:'#101e3d',edge:'#536d9e',accent:'#bdccee'}:{base:'#91898c',edge:'#c03423',accent:'#edc5b9'};
 const fill=(x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
 const border=(x,y,w,h,color,dash=[])=>{c.strokeStyle=color;c.lineWidth=2;c.setLineDash(dash);c.strokeRect(x,y,w,h);c.setLineDash([]);};
 const text=(value,x,y,size=24,color='#ddd')=>{c.fillStyle=color;c.font=size+'px SimSun,"Songti SC",serif';c.textBaseline='top';c.fillText(value,x,y);};
 function paragraph(value,x,y,width,height,maxSize=28,bold=false){
  const content=value||'';
  if(!content)return;
  let rows=[],size=maxSize;
  for(;size>=10;size--){
   c.font=(bold?'bold ':'')+size+'px SimSun,"Songti SC",serif';rows=[];
   for(const part of content.split('\n')){
    let line='';
    for(const glyph of part){if(line&&c.measureText(line+glyph).width>width){rows.push(line);line='';}line+=glyph;}
    rows.push(line);
   }
   if(rows.length*(size+6)<=height)break;
  }
  c.save();c.beginPath();c.rect(x,y,width,height);c.clip();
  rows.forEach((row,index)=>{
 if(bold){c.fillStyle='#fff5e7';c.font='bold '+size+'px SimSun,"Songti SC",serif';c.textBaseline='top';c.fillText(row,x,y+index*(size+6));}
 else text(row,x,y+index*(size+6),size);
 });
 c.restore();
 }
 function cover(image,x,y,w,h){
  const scale=Math.max(w/image.width,h/image.height);
  c.save();c.beginPath();c.rect(x,y,w,h);c.clip();
  c.drawImage(image,x+(w-image.width*scale)/2,y+(h-image.height*scale)/2,image.width*scale,image.height*scale);c.restore();
 }
 fill(0,0,1600,1000,palette.base);
 const atmosphere=c.createLinearGradient(0,0,1600,1000);
 atmosphere.addColorStop(0,'#070b12aa');atmosphere.addColorStop(.4,'#00000000');atmosphere.addColorStop(1,'#06132699');
 c.fillStyle=atmosphere;c.fillRect(0,0,1600,1150);
 for(let x=0;x<1600;x+=80)fill(x,0,1,1150,'#aeb3bb09');
 for(let y=0;y<1150;y+=80)fill(0,y,1600,1,'#aeb3bb09');
 for(let y=0;y<1000;y+=4)fill(0,y,1600,1,'#00000030');




 const buildingLayer=document.createElement('canvas');buildingLayer.width=1090;buildingLayer.height=730;
 const bc=buildingLayer.getContext('2d');
 const bs=Math.min(1090/buildingImage.width,730/buildingImage.height);
 bc.drawImage(buildingImage,0,730-buildingImage.height*bs,buildingImage.width*bs,buildingImage.height*bs);
 bc.globalCompositeOperation='destination-in';
 const fade=bc.createLinearGradient(0,0,1090,0);fade.addColorStop(0,'#000');fade.addColorStop(.72,'#000');fade.addColorStop(1,'#0000');
 bc.fillStyle=fade;bc.fillRect(0,0,1090,730);
 c.save();c.globalAlpha=.33;c.filter='saturate(.7)';c.drawImage(buildingLayer,-35,280,1090,730);c.restore();
 drawBackgroundDetails(c);
 const vignette=c.createRadialGradient(800,450,250,800,450,950);
 vignette.addColorStop(0,'#00000000');vignette.addColorStop(1,'#02060b80');
 c.fillStyle=vignette;c.fillRect(0,0,1600,1000);
 c.save();c.globalAlpha=.62;c.strokeStyle='#b9b8ad';c.lineWidth=2;
 [[18,18,1,1],[1582,18,-1,1],[18,1132,1,-1],[1582,1132,-1,-1]].forEach(([x,y,dx,dy])=>{
 c.beginPath();c.moveTo(x+25*dx,y);c.lineTo(x,y);c.lineTo(x,y+25*dy);c.stroke();
 });
 c.font='14px "Courier New",monospace';c.textBaseline='top';c.fillStyle='#bf392b';c.fillText('●',60,20);
 c.fillStyle='#c9c4b9';c.fillText('REC',78,20);c.fillText('PLAYBACK / PROFILE',1380,1117);c.restore();
 c.save();c.translate(48,30);c.scale(.94,.94);
 c.save();c.translate(748,133);c.globalAlpha=office?.56:.448;paintLogo(c,-150,-145,300,290);c.restore();

 fill(50,80,600,790,'#0c2945');fill(42,76,600,790,'#164268');fill(51,84,600,790,'#00000080');fill(54,89,600,790,'#00000070');fill(53,97,600,790,'#00000050');fill(49,79,600,790,'#060c17');
 fill(680,246,395,895,'#0c2945');fill(672,242,395,745,'#164268');fill(682,251,395,745,'#00000080');fill(686,256,395,745,'#00000070');fill(683,263,395,745,'#00000050');fill(679,245,395,745,'#060c17');
 const windowBody=c.createLinearGradient(0,74,0,864);
 windowBody.addColorStop(0,'#0a080d');windowBody.addColorStop(.4,'#141018');windowBody.addColorStop(1,'#32232a');
 c.fillStyle=windowBody;c.fillRect(45,74,600,790);border(45,74,600,790,'#e22b18');
 function windowTitle(x,y,w,h){
 const gradient=c.createLinearGradient(0,y,0,y+h);
 gradient.addColorStop(0,'#c5735a');gradient.addColorStop(.09,'#b3452f');gradient.addColorStop(.47,'#7d201b');gradient.addColorStop(.5,'#3c0c12');gradient.addColorStop(1,'#642025');
 c.fillStyle=gradient;c.fillRect(x,y,w,h);
 fill(x,y,w,1,'#d0a99b77');

}
 windowTitle(47,76,596,48);
 border(598,86,29,29,palette.edge);text('×',601,85,26,'#ff3526');
 text('怪啖论坛 / 个人主页',65,91,24,palette.accent);border(63,129,564,1,palette.edge,[7,5]);
 cover(avatar,76,155,155,155);border(76,155,155,155,palette.edge);
 paragraph(state.nickname,254,153,360,82,42,true);
 text('性别',254,267,20,'#d7c9ba');text('年龄',438,267,20,'#d7c9ba');
 fill(309,260,118,39,'#101722');fill(492,260,122,39,'#101722');
 paragraph(state.publicGender||'保密',315,267,110,30,21);
 paragraph(state.publicAge||'保密',498,267,116,30,21);

 function insetPanel(title,value,y,height){
  const heading=c.createLinearGradient(0,y,0,y+31);heading.addColorStop(0,'#983a2b');heading.addColorStop(.48,'#642119');heading.addColorStop(1,'#391211');c.fillStyle=heading;c.fillRect(76,y,538,31);border(76,y,538,height,'#972216');
  text(title,86,y+4,21,'#f0d8cc');
  const gradient=c.createLinearGradient(0,y+31,0,y+height);
  gradient.addColorStop(0,'#141b2a');gradient.addColorStop(.55,'#253044');gradient.addColorStop(1,'#3b4555');
  c.fillStyle=gradient;c.fillRect(77,y+31,536,height-32);fill(77,y+31,536,1,'#a63020');
  paragraph(value,92,y+45,506,height-60,27);
 }
 insetPanel('个性签名',state.signature?.trim()||'用户未填写个性签名',351,143);
 insetPanel('个人简介',state.intro?.trim()||'用户未填写个人简介',526,313);




 const separator=c.createLinearGradient(926,0,1581,0);
 separator.addColorStop(0,'#00000065');separator.addColorStop(.12,'#080e1c80');separator.addColorStop(.65,'#05091370');separator.addColorStop(1,'#0000003d');
 c.fillStyle=separator;c.fillRect(926,-32,655,1065);fill(926,-32,1,1065,'#d6b5a31a');

 text('档案',970,15,32,'#f0d1c6');text('// '+(office?'异常对策课':'怪谈侦探'),1060,15,32,'#f0d1c6');
 c.font='12px "Courier New",monospace';c.fillStyle='#c3aaa2';c.fillText('PERSONNEL FILE',970,59);fill(970,80,548,1,'#c48d7b50');
 const grid=[['姓名','realName',970,101,'name'],['种族','species',1270,101,'species'],
 ['性别','realGender',970,157,'gender'],['年龄','realAge',1270,157,'age'],['身高','height',1270,213,'height']];
 grid.forEach(([label,key,x,y,english])=>{
  text(label,x,y+10,23,palette.accent);
  fill(x+73,y,180,42,'#00000012');border(x+73,y,180,42,'#b9786530');
  paragraph(state[key],x+81,y+8,164,32,22);
 });
 fill(1104,270,476,1,'#c48d7b50');
 text('人物设定',1104,285,28,'#f0d1c6');
 c.font='15px "Courier New",monospace';c.fillStyle='#c3aaa2';c.fillText('// profile',1235,299);
 fill(1104,334,476,758,'#00000012');border(1104,334,476,758,palette.edge,[7,5]);
 for(let y=368;y<1092;y+=34)fill(1106,y,472,1,'#adbbce09');
 paragraph(state.history,1127,385,388,547,26);
 fill(675,240,395,745,'#06090b');border(675,240,395,745,'#e22b18');
 windowTitle(677,242,391,46);
 text('个人形象',687,252,24,palette.accent);
 border(1029,250,29,29,palette.edge);text('×',1032,249,26,'#ff3526');
 border(677,288,391,1,palette.edge,[8,6]);
 const px=689,py=304,pw=367,ph=667;

 const portraitGround=c.createLinearGradient(0,py,0,py+ph);
 portraitGround.addColorStop(0,'#b0bac0');portraitGround.addColorStop(1,'#76838d');
 c.fillStyle=portraitGround;c.fillRect(px,py,pw,ph);
 if(!portrait){
 paintSmile(c,px+(pw-140)/2,py+(ph-300)/2-30,340);
 c.save();c.textAlign='center';text('用户未展示个人形象',px+pw/2,py+ph/2+205,18,'#35424b');c.restore();
 }border(px,py,pw,ph,'#ff1300');
 if(portrait){
  const scale=Math.min(pw/portrait.width,ph/portrait.height)*state.zoom;
  const w=portrait.width*scale,h=portrait.height*scale;
  c.save();c.beginPath();c.rect(px,py,pw,ph);c.clip();c.drawImage(portrait,px+(pw-w)/2+state.x*pw,py+(ph-h)/2+state.y*ph,w,h);c.restore();
 }


 drawForumSignature(c,55,914);
 c.restore();
 return canvas;
}
$('#export').onclick=async()=>{
 const button=$('#export');
 if(avatarLoading||portraitLoading){setStatus('图片还在读取，请稍等。');return;}
 if(!state.nickname.trim()){setStatus('请填写网名。');$('#nickname').focus();return;}
 button.disabled=true;setStatus('正在生成 PNG…');
 try{
  await Promise.all([logoReady,buildingReady]);
  if(typeof html2canvas!=='function'){
   /* html2canvas 兜底：加载失败时动态重载一次（站点绝对路径 → 工具相对路径），仍失败才报错 */
   const cands=location.protocol==='file:'?['./assets/card-capture.js']:['/tools/card/assets/card-capture.js','./assets/card-capture.js'];
   for(const u of cands){
    if(typeof html2canvas==='function')break;
    await new Promise(res=>{const s=document.createElement('script');let done=false;const fin=()=>{if(!done){done=true;res();}};s.src=u+(u.indexOf('?')<0?'?':'&')+'retry='+Date.now();s.onload=fin;s.onerror=fin;setTimeout(fin,15000);document.head.appendChild(s);});
   }
   if(typeof html2canvas!=='function')throw Error('导出组件加载失败（多半是网络波动），请稍后刷新页面后再试。');
  }
  await document.fonts.ready;
  // Keep local image decoding origin-clean for the screenshot.
  document.querySelector('.building-decoration').src=buildingImage.src;
  const canvas=await html2canvas($('#sheet'),{
   scale:2,width:1600,height:1000,backgroundColor:null,logging:false,
   onclone:async doc=>{
    const card=doc.querySelector('#sheet');
    for(const selector of ['.forum','.portrait-shell']){
      const original=document.querySelector('#sheet '+selector);
      const cloned=doc.querySelector('#sheet '+selector);
      const width=original.offsetWidth,height=original.offsetHeight;
      const layer=document.createElement('canvas');layer.width=width+110;layer.height=height+120;
      const brush=layer.getContext('2d');
      brush.fillStyle='#000';brush.shadowColor='rgba(0,0,0,.8)';
      brush.shadowBlur=22;brush.shadowOffsetX=9;brush.shadowOffsetY=18;
      brush.fillRect(40,35,width,height);
      brush.shadowColor='transparent';brush.clearRect(40,35,width,height);
      const shadow=doc.createElement('img');shadow.src=layer.toDataURL('image/png');
      shadow.style.cssText='position:absolute;pointer-events:none;max-width:none;max-height:none;';
      shadow.style.left=(original.offsetLeft-40)+'px';
      shadow.style.top=(original.offsetTop-35)+'px';
      shadow.style.width=layer.width+'px';shadow.style.height=layer.height+'px';
      shadow.style.zIndex=selector==='.portrait-shell'?'3':'1';
      doc.querySelector('.card-content').appendChild(shadow);
      cloned.style.zIndex=selector==='.portrait-shell'?'4':'2';
      await shadow.decode();
    }

    card.style.transform='none';card.style.position='relative';card.style.left='0';card.style.top='0';
    const viewport=doc.querySelector('#preview-viewport');
    viewport.style.width='1600px';viewport.style.height='1000px';viewport.style.overflow='visible';
    doc.querySelectorAll('#sheet input,#sheet textarea,#sheet select').forEach(field=>{
      const original=document.querySelector('[data-key="'+field.dataset.key+'"]');
      if(!original)return;
      const computed=getComputedStyle(original),replacement=doc.createElement('div');
      for(const property of computed)replacement.style.setProperty(property,computed.getPropertyValue(property));
      replacement.style.margin='0';replacement.style.overflow='hidden';replacement.style.whiteSpace=field.tagName==='TEXTAREA'?'pre-wrap':'nowrap';
      replacement.style.overflowWrap='anywhere';
      const fallback={signature:'用户未填写个性签名',intro:'用户未填写个人简介',publicAge:'保密'};
      replacement.textContent=original.value.trim()||fallback[field.dataset.key]||'';
      if(['publicGender','publicAge'].includes(field.dataset.key)){
        replacement.style.setProperty('font-size','25px','important');
        replacement.style.setProperty('font-family','SimSun,"Songti SC",serif','important');
        replacement.style.setProperty('line-height','39px','important');
        replacement.style.setProperty('padding','0 8px','important');
        replacement.style.setProperty('height','39px','important');
        replacement.style.setProperty('display','block');
        replacement.style.setProperty('box-sizing','border-box');
        replacement.style.setProperty('transform','none');
      }

      field.replaceWith(replacement);
    });
    if(!portrait){
      const placeholder=doc.querySelector('#portrait-placeholder');
      placeholder.querySelector('span').textContent='用户未展示个人形象';
    }
   }
  });
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!blob)throw Error('图片生成失败，请重试。');
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=(state.nickname.replace(/[<>:"/\|?*\x00-\x1f]/g,'_')||'角色企卡')+'.png';
  a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);setStatus('高清 PNG（3200 × 2000）已生成，请查看浏览器下载。');
 }catch(error){setStatus(error.message||'导出失败，请重试。');}
 finally{button.disabled=false;}
};


$('#registration').hidden=false;$('#editor').hidden=true;

})();
