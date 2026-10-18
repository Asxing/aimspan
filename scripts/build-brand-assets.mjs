import { app, BrowserWindow } from "electron";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Mechanical rasterization of the same repo-native vector used by both UIs.
// No external image, font, network request, production State or account data.
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=join(root,"apps","desktop","dist","brand");
/** Bounding box of the drawn glyph (legs, span bar, aim dot) inside the 128-unit vector. */
const GLYPH_BOX=Object.freeze({x:25.5,y:30.5,width:78.5,height:67});
const scratch=mkdtempSync(join(tmpdir(),"__aimspan_fixture__-brand-render-"));
app.setPath("userData",scratch);
app.disableHardwareAcceleration();
let window;
let phase='ready';
const deadline=setTimeout(()=>{process.stderr.write(`Brand asset deadline exceeded (${phase}).\n`);window?.destroy();void rm(scratch,{recursive:true,force:true}).finally(()=>app.exit(1));},20000);
async function main(){
try{
  const svg=await readFile(join(root,"apps","desktop","src","renderer","assets","aimspan-icon.svg"),"utf8");
  if(svg.length>32768||/<(?:script|image|foreignObject|use)\b|(?:href|url)\s*[=(]/i.test(svg))throw new Error("The brand vector must be self-contained.");
  await app.whenReady();app.dock?.hide();
  phase='render';
  window=new BrowserWindow({show:false,width:1024,height:1024,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:"><body></body>');
  const source=`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  // The menu-bar (status item) icon is the same glyph without its tile, drawn
  // in solid black so macOS can recolour it as a template image.
  const glyph=svg.replace(/<rect\b[^>]*\/>/g,"").replace(/(stroke|fill)="#[0-9A-Fa-f]{3,8}"/g,'$1="#000000"').replace(/ stroke-opacity="[^"]*"/g,"");
  if(/#(?!000000)[0-9A-Fa-f]{6}/.test(glyph))throw new Error("The template glyph must be monochrome.");
  const glyphSource=`data:image/svg+xml;base64,${Buffer.from(glyph).toString("base64")}`;
  const rendered=await window.webContents.executeJavaScript(`(async()=>{
    const load=async source=>{const image=new Image();image.src=source;await image.decode();return image;};
    const icon=await load(${JSON.stringify(source)});const glyph=await load(${JSON.stringify(glyphSource)});
    const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;const context=canvas.getContext('2d');context.drawImage(icon,0,0,1024,1024);
    if(context.getImageData(0,0,1,1).data[3]!==0)throw Error('App icon corners must be transparent');
    // Glyph bounds inside the 128-unit vector; the template centres it in a 22pt box.
    const box=${JSON.stringify(GLYPH_BOX)};const template=scale=>{const size=22*scale;const glyphSize=18*scale;const ratio=glyphSize/Math.max(box.width,box.height);const drawn=128*ratio;const c=document.createElement('canvas');c.width=size;c.height=size;const g=c.getContext('2d');g.drawImage(glyph,size/2-(box.x+box.width/2)*ratio,size/2-(box.y+box.height/2)*ratio,drawn,drawn);return c.toDataURL('image/png');};
    return {icon:canvas.toDataURL('image/png'),tray1x:template(1),tray2x:template(2)};
  })()`);
  const decode=(value,label)=>{if(typeof value!=="string"||!value.startsWith("data:image/png;base64,"))throw new Error(`Brand rasterization failed (${label}).`);return Buffer.from(value.slice("data:image/png;base64,".length),"base64");};
  await mkdir(output,{recursive:true});
  await writeFile(join(output,"aimspan.png"),decode(rendered?.icon,"icon"));
  await writeFile(join(output,"trayTemplate.png"),decode(rendered?.tray1x,"tray"));
  await writeFile(join(output,"trayTemplate@2x.png"),decode(rendered?.tray2x,"tray@2x"));
  process.stdout.write("AimSpan brand assets generated from the canonical local vector.\n");
}catch(error){process.stderr.write(`${error instanceof Error?error.message:"Brand asset build failed"}\n`);process.exitCode=1;}
finally{clearTimeout(deadline);window?.destroy();await rm(scratch,{recursive:true,force:true});app.exit(process.exitCode??0);}
}
// Electron's ready event waits for ESM evaluation; do not await ready at top level.
void main();
