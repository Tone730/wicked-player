const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("api",{openDevTools:()=>ipcRenderer.send("open-devtools")});
