const { app, BrowserWindow } = require('electron')
const path = require('path')

let win;

// 开启 WASM + 文件权限
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')
app.commandLine.appendSwitch('allow-file-access-from-files')

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      webSecurity: false,
      nativeWindowOpen: true
    }
  })

  // 加载页面（你现在正确的结构）
  win.loadFile(
    path.join(__dirname, 'dist/index.html')
  )
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})