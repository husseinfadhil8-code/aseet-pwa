"""Export the unchanged official vector logo to PNG for iOS/Android compatibility."""
import base64,shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
svg=base64.b64encode((root/'assets/waseet-icon.svg').read_bytes()).decode()
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])
    page=browser.new_page()
    for name,size,padding in [('waseet-192.png',192,0),('waseet-512.png',512,0),('apple-touch-icon.png',180,0),('waseet-maskable-512.png',512,52)]:
        data=page.evaluate("""async({svg,size,padding})=>{const img=new Image();img.src='data:image/svg+xml;base64,'+svg;await img.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=size;const ctx=canvas.getContext('2d');ctx.fillStyle='#0B192C';ctx.fillRect(0,0,size,size);ctx.drawImage(img,padding,padding,size-padding*2,size-padding*2);return canvas.toDataURL('image/png').split(',')[1];}""",{'svg':svg,'size':size,'padding':padding})
        (root/'assets'/name).write_bytes(base64.b64decode(data))
    browser.close()
