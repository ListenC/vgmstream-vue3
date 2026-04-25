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

### 📱 APK（Android/Capacitor）

#### 前置要求

- Node.js 16+
- JDK 11 或更高版本
- Android SDK
- 配置好 `ANDROID_HOME` 环境变量

#### 构建步骤

1. **安装依赖并构建Web资源**

```bash
npm install
npm run build
```

2. **同步 Capacitor 项目**

```bash
npx cap sync
```

3. **构建 Android APK**

```bash
cd android
./gradlew assembleRelease
```

生成的 APK 文件位于：`android/app/build/outputs/apk/release/app-release.apk`

或使用 Android Studio 打开项目并构建。

#### 问题排查

如果打包后文件加载卡死，请确保：
- ✅ `npm run build` 完成后 `dist/vgmstream/` 目录存在
- ✅ WASM 文件（`vgmstream-cli.wasm`、`vgmstream-cli.js`）已被复制到 dist 目录
- ✅ 运行 `npx cap sync` 将资源同步到 Android 项目

## 第三方开源资源

本项目内置 [vgmstream](https://github.com/vgmstream/vgmstream) 编译产物（r2083），用于游戏音频解析：
- `public/vgmstream-cli.js`
- `public/vgmstream-cli.wasm`

原始项目：https://github.com/vgmstream/vgmstream  
开源协议：**ISC License**（宽松开源，允许二次分发）  
编译产物版权归原项目开发者所有。

参考 [vgmstream-web](https://github.com/KatieFrogs/vgmstream-web)
