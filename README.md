# Vue 3 + vgmstream

## 游戏音频离线播放

通过 Vue 3 实现 vgmstream 解析游戏音频并实时播放

## 构建

### 🌐 Web

开发运行：

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
```

### 🖥 EXE（Electron）

构建：

```bash
cd electron
npm install
npm run build
```

## 第三方开源资源

本项目内置 [vgmstream](https://github.com/vgmstream/vgmstream) 编译产物（r2083），用于游戏音频解析：
- `public/vgmstream-cli.js`
- `public/vgmstream-cli.wasm`

原始项目：https://github.com/vgmstream/vgmstream  
开源协议：**ISC License**（宽松开源，允许二次分发）  
编译产物版权归原项目开发者所有。

参考 [vgmstream-web](https://github.com/KatieFrogs/vgmstream-web)
