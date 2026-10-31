const { app, BrowserWindow } = require("electron");
const path = require("path");
function createWindow(){
  const win = new BrowserWindow({
    width:1400,height:800,webPreferences:{nodeIntegration:true}
  });
  win.loadFile(path.join(__dirname,"..","wicked-frontend","dist","index.html"));
}
app.whenReady().then(createWindow);
app.on("window-all-closed",()=>{ if(process.platform!=="darwin") app.quit(); });
